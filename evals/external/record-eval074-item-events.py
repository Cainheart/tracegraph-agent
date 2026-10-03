#!/usr/bin/env python3
"""Write sanitized per-question benchmark score facts to Agent Trace."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
REPO_PARENT = ROOT.parent
sys.path.insert(0, str(REPO_PARENT / "tools"))
from agent_trace import EventWriter, read_events  # noqa: E402


RUN_ID = "run:ccb861a365e6"
TRACE_ID = "trace:ccb861a365e6"
LEDGER = REPO_PARENT / ".agent-traces/run-076483b45acb62f0d9c3.events.jsonl"
ARTIFACTS = ROOT / "docs/validation/2026-10-03-eval074-public-benchmarks"
REPORT = ARTIFACTS / "report.json"
ITEM_FILES = [
    (ARTIFACTS / "longmemeval-items.jsonl", "LongMemEval_S", "memory"),
    (ARTIFACTS / "longmemeval-v2-items.jsonl", "LongMemEval_V2_small_text_only", "experience"),
]


def read_items(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_items(path: Path, items: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for item in items:
            handle.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")


def delta(control: bool, treatment: bool) -> int:
    return int(treatment) - int(control)


def score_summary(item: dict[str, Any], lane: str) -> tuple[dict[str, Any], dict[str, Any]]:
    if lane == "memory":
        memory = item["memory"]
        judge = memory["upstream_prompt_local_judge"]
        return (
            {
                "lane": "Memory",
                "dataset": "LongMemEval_S cleaned",
                "question_id": item["question_id"],
                "task_family": item["task_family"],
            },
            {
                "primary_metric": "normalized_exact_match",
                "control_score": bool(memory["control_exact_match"]),
                "treatment_score": bool(memory["exact_match"]),
                "paired_delta": delta(bool(memory["control_exact_match"]), bool(memory["exact_match"])),
                "upstream_prompt_local_judge_control": judge["control_score"],
                "upstream_prompt_local_judge_treatment": judge["treatment_score"],
                "answer_session_recall_at_8": memory["answer_session_recall_at_8"],
                "answer_session_hit_at_8": memory["hit_at_8"],
                "retrieval_count": memory["retrieval_count"],
            },
        )
    experience = item["experience"]
    return (
        {
            "lane": "Experience",
            "dataset": "LongMemEval-V2 small text-only",
            "question_id": item["question_id"],
            "task_family": item["task_family"],
            "domain": item.get("domain"),
        },
        {
            "scorer": "pinned LongMemEval-V2 eval_function and rubric; local qwen judge where required",
            "control_score": bool(experience["control_official_score"]),
            "treatment_score": bool(experience["official_score"]),
            "paired_delta": delta(bool(experience["control_official_score"]), bool(experience["official_score"])),
            "retrieval_count": experience["retrieval_count"],
            "validated_case_count": experience["validated_case_count"],
            "eval_function": experience["eval_function"],
        },
    )


def main() -> None:
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    ledger_events = read_events(LEDGER, expected_run_id=RUN_ID, expected_trace_id=TRACE_ID)
    writer = EventWriter(LEDGER, run_id=RUN_ID, trace_id=TRACE_ID)
    event_by_id = {event.event_id: event for event in ledger_events}
    expected = int(report["completed_pairs"]["total"])
    item_event_ids: dict[str, str] = {}
    event_count = 0

    if len(ledger_events) < 28:
        raise SystemExit("canonical EVAL-074 setup events are incomplete")

    for path, dataset_key, lane in ITEM_FILES:
        items = read_items(path)
        for item in items:
            event_id = item.get("source_event_id")
            if event_id:
                event = event_by_id.get(event_id)
                if event is None or event.operation != "evaluation.public_item.scored":
                    raise SystemExit(f"stale or invalid item event reference for {item['question_id']}")
                item_event_ids[f"{dataset_key}:{item['question_id']}"] = event_id
                continue

            input_summary, output_summary = score_summary(item, lane)
            prompt_version = report["protocol"]["prompt_sha256_by_lane"][lane]
            key = f"eval074-public-item-{dataset_key}-{item['question_id']}"
            event = writer.append(
                component="evaluation",
                stage="public-benchmark-scoring",
                operation="evaluation.public_item.scored",
                status="succeeded",
                operation_id="operation:eval074-public-run",
                model=report["model"]["name"],
                prompt_version=prompt_version,
                knowledge_version=dataset_key,
                config_digest="sha256:" + hashlib.sha256(json.dumps(report["protocol"], sort_keys=True).encode()).hexdigest(),
                input_summary=input_summary,
                output_summary=output_summary,
                idempotency_key=key,
            )
            event_by_id[event.event_id] = event
            item_event_ids[f"{dataset_key}:{item['question_id']}"] = event.event_id
            event_count += 1

        for item in items:
            event_id = item_event_ids[f"{dataset_key}:{item['question_id']}"]
            item.update({
                "source_run_id": RUN_ID,
                "source_trace_id": TRACE_ID,
                "source_event_id": event_id,
                "prompt_sha256": report["protocol"]["prompt_sha256_by_lane"][lane],
            })
        write_items(path, items)

    if len(item_event_ids) != expected:
        raise SystemExit(f"expected {expected} per-item events, found {len(item_event_ids)}")

    all_items = [read_items(path) for path, _, _ in ITEM_FILES]
    first_sequence = min(event_by_id[item["source_event_id"]].sequence for rows in all_items for item in rows)
    last_sequence = max(event_by_id[item["source_event_id"]].sequence for rows in all_items for item in rows)
    report["canonical_trace"] = {
        "run_id": RUN_ID,
        "trace_id": TRACE_ID,
        "item_score_operation": "evaluation.public_item.scored",
        "item_event_count": len(item_event_ids),
        "item_event_sequence_range": [first_sequence, last_sequence],
        "attempt_history_event_ids": [entry["event_id"] for entry in report["attempt_history"]],
        "per_item_event_ids_stored_in_item_jsonl": True,
    }
    for path, dataset_key, _lane in ITEM_FILES:
        report["artifacts"][f"{dataset_key}_item_scores_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")

    final_events = read_events(LEDGER, expected_run_id=RUN_ID, expected_trace_id=TRACE_ID)
    print(json.dumps({
        "added_item_events": event_count,
        "item_event_count": len(item_event_ids),
        "item_sequence_range": [first_sequence, last_sequence],
        "ledger_events_now": len(final_events),
        "v1_items": len(all_items[0]),
        "v2_items": len(all_items[1]),
        "report": str(REPORT),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
