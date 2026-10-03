#!/usr/bin/env python3
"""Finalize the public EVAL-074 report from sanitized item/judge caches.

This script stores labels, fingerprints, resource counts, and confidence
intervals only. Raw benchmark text and generated answers remain in the
temporary run directory and are removed after the report is finalized.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "docs/validation/2026-10-03-eval074-public-benchmarks"
TEMP = Path("/tmp/outlive-eval074-20261003")
REPORT = ARTIFACTS / "report.json"
V1_ITEMS = ARTIFACTS / "longmemeval-items.jsonl"
V1_CACHE = TEMP / "v1-score-cache.jsonl"
V2_CACHE = TEMP / "v2-score-cache.jsonl"
V1_SCORER = ROOT / "evals/external/score-eval074-v1.py"
ITEM_EVENT_WRITER = ROOT / "evals/external/record-eval074-item-events.py"
V1_UPSTREAM = TEMP / "LongMemEval/src/evaluation/evaluate_qa.py"
BOOTSTRAP_SEED = 20261007
BOOTSTRAP_DRAWS = 10_000


def jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def i32(value: int) -> int:
    value &= 0xFFFFFFFF
    return value if value < 0x80000000 else value - 0x100000000


def imul(left: int, right: int) -> int:
    return i32((left & 0xFFFFFFFF) * (right & 0xFFFFFFFF))


def make_rng(seed: int):
    """Match the JS runner's Mulberry32-style ``makeRng`` implementation."""
    value = seed & 0xFFFFFFFF

    def next_value() -> float:
        nonlocal value
        value = (value + 0x6D2B79F5) & 0xFFFFFFFF
        t = i32(value)
        t = imul(i32(t ^ ((t & 0xFFFFFFFF) >> 15)), i32(t | 1))
        t = i32(t ^ i32(t + imul(i32(t ^ ((t & 0xFFFFFFFF) >> 7)), i32(t | 61))))
        return (i32(t ^ ((t & 0xFFFFFFFF) >> 14)) & 0xFFFFFFFF) / 4294967296

    return next_value


def paired_summary(rows: list[dict[str, Any]], control_key: str, treatment_key: str) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[row["task_family"]].append(row)
    rng = make_rng(BOOTSTRAP_SEED)
    deltas: list[float] = []
    for _ in range(BOOTSTRAP_DRAWS):
        total = 0.0
        count = 0
        for group in grouped.values():
            for _ in range(len(group)):
                row = group[int(rng() * len(group))]
                total += int(bool(row[treatment_key])) - int(bool(row[control_key]))
                count += 1
        deltas.append(total / count)
    deltas.sort()
    wins = sum(row[treatment_key] and not row[control_key] for row in rows)
    losses = sum(row[control_key] and not row[treatment_key] for row in rows)
    return {
        "n": len(rows),
        "wins": wins,
        "ties": len(rows) - wins - losses,
        "losses": losses,
        "absolute_delta": sum(int(bool(row[treatment_key])) - int(bool(row[control_key])) for row in rows) / len(rows),
        "confidence_interval_95": [deltas[int(BOOTSTRAP_DRAWS * 0.025)], deltas[int(BOOTSTRAP_DRAWS * 0.975)]],
        "bootstrap": {
            "draws": BOOTSTRAP_DRAWS,
            "sampling": "task-family-stratified paired bootstrap; preserve each family sample size",
            "seed": BOOTSTRAP_SEED,
            "rng": "same 32-bit generator as eval074-public-memory-experience.mjs",
        },
    }


def rates(rows: list[dict[str, Any]], key: str) -> dict[str, Any]:
    positives = sum(bool(row[key]) for row in rows)
    return {"n": len(rows), "value": positives / len(rows), "positives": positives}


def family_metrics(rows: list[dict[str, Any]], control_key: str, treatment_key: str) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[row["task_family"]].append(row)
    result = {}
    for family, group in grouped.items():
        control = sum(bool(row[control_key]) for row in group)
        treatment = sum(bool(row[treatment_key]) for row in group)
        result[family] = {
            "n": len(group),
            "control_rate": control / len(group),
            "treatment_rate": treatment / len(group),
            "delta": (treatment - control) / len(group),
        }
    return result


def main() -> None:
    if not all(path.is_file() for path in (REPORT, V1_ITEMS, V1_CACHE, V2_CACHE, V1_SCORER, V1_UPSTREAM)):
        raise SystemExit("required report, score caches, or pinned source files are missing")

    report = json.loads(REPORT.read_text(encoding="utf-8"))
    items = jsonl(V1_ITEMS)
    scores = {(row["question_id"], row["arm"]): row for row in jsonl(V1_CACHE)}
    if len(items) != 500 or len(scores) != 1000:
        raise SystemExit(f"expected 500 items and 1000 local judge rows, found {len(items)} and {len(scores)}")

    judge_rows = []
    total_judge_tokens = 0
    total_judge_latency = 0
    for item in items:
        question_id = item["question_id"]
        control = scores[(question_id, "control")]
        treatment = scores[(question_id, "memory")]
        if control["judge_done_reason"] != "stop" or treatment["judge_done_reason"] != "stop":
            raise SystemExit(f"non-terminal judge response for {question_id}")
        item["memory"]["upstream_prompt_local_judge"] = {
            "control_score": bool(control["label"]),
            "treatment_score": bool(treatment["label"]),
            "prompt_source": "pinned LongMemEval evaluate_qa.py:get_anscheck_prompt",
            "judge_model": treatment["judge_model"],
            "judge_model_digest": treatment["judge_model_digest"],
            "judge_output_fingerprints": {
                "control": control["judge_output_fingerprint"],
                "treatment": treatment["judge_output_fingerprint"],
            },
            "judge_token_counts": {
                "control_input": control["judge_prompt_tokens"],
                "control_output": control["judge_completion_tokens"],
                "treatment_input": treatment["judge_prompt_tokens"],
                "treatment_output": treatment["judge_completion_tokens"],
            },
            "judge_latency_ms": {
                "control": control["judge_latency_ms"],
                "treatment": treatment["judge_latency_ms"],
            },
        }
        judge_rows.append({
            "task_family": item["task_family"],
            "control": bool(control["label"]),
            "treatment": bool(treatment["label"]),
        })
        for score in (control, treatment):
            total_judge_tokens += int(score["judge_prompt_tokens"] or 0) + int(score["judge_completion_tokens"] or 0)
            total_judge_latency += int(score["judge_latency_ms"] or 0)

    with V1_ITEMS.open("w", encoding="utf-8", newline="\n") as handle:
        for item in items:
            handle.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")

    official_local = {
        "scoring_name": "LongMemEval upstream answer-check prompt with local qwen3:4b-instruct judge",
        "upstream_prompt_only": True,
        "hosted_judge_equivalence": False,
        "control_rate": rates(judge_rows, "control"),
        "treatment_rate": rates(judge_rows, "treatment"),
        "paired": paired_summary(judge_rows, "control", "treatment"),
        "family_metrics": family_metrics(judge_rows, "control", "treatment"),
    }
    report["results"]["memory"]["upstream_prompt_local_judge"] = official_local
    report["implementation"]["v1_local_judge_bridge_sha256"] = sha256(V1_SCORER)
    report["implementation"]["v1_upstream_evaluator_source_sha256"] = sha256(V1_UPSTREAM)
    report["implementation"]["report_finalizer_sha256"] = sha256(Path(__file__).resolve())
    report["implementation"]["item_event_writer_sha256"] = sha256(ITEM_EVENT_WRITER)
    report["datasets"]["longmemeval"]["scorer_source_sha256"] = sha256(V1_UPSTREAM)
    judge_bootstrap_note = "; Memory upstream-prompt local-judge seed 20261007 (10,000 draws)"
    if judge_bootstrap_note not in report["protocol"]["bootstrap"]:
        report["protocol"]["bootstrap"] += judge_bootstrap_note

    v2_scores = jsonl(V2_CACHE)
    v2_local_scores = [row for row in v2_scores if row.get("judge_prompt_tokens") is not None]
    if len(v2_local_scores) != 256:
        raise SystemExit(f"expected 256 complete V2 local judge rows, found {len(v2_local_scores)}")
    v1_judge_calls = len(scores)
    v2_judge_calls = len(v2_local_scores)
    v2_judge_tokens = sum(int(row.get("judge_prompt_tokens") or 0) + int(row.get("judge_completion_tokens") or 0) for row in v2_local_scores)
    v2_judge_latency = sum(int(row.get("scoring_latency_ms") or 0) for row in v2_local_scores)
    resources = report["resources"]
    if "evaluation_process_elapsed_ms" in resources:
        resources["final_resume_process_elapsed_ms"] = resources.pop("evaluation_process_elapsed_ms")
    if "final_resume_process_elapsed_ms" not in resources:
        raise SystemExit("final V2 resume process timing is absent")
    resources["evaluation_elapsed_scope"] = "final V2 resume process only; excludes earlier invalidated attempts and V1 generation/scoring"
    if "model_calls_in_report_generation_process" in resources:
        resources["v2_generation_calls_in_final_resume_process"] = resources.pop("model_calls_in_report_generation_process")
    if "cached_calls_reused_in_report_generation_process" in resources:
        resources["v2_cached_calls_reused_in_final_resume_process"] = resources.pop("cached_calls_reused_in_report_generation_process")
    resources["longmemeval_local_judge_calls"] = v1_judge_calls
    resources["longmemeval_v2_local_judge_calls"] = v2_judge_calls
    resources["local_judge_calls"] = v1_judge_calls + v2_judge_calls
    resources["longmemeval_local_judge_tokens"] = total_judge_tokens
    resources["longmemeval_v2_local_judge_tokens"] = v2_judge_tokens
    resources["local_judge_tokens"] = total_judge_tokens + v2_judge_tokens
    resources["local_judge_tokens_reported_by_ollama"] = resources["local_judge_tokens"]
    resources["longmemeval_local_judge_scoring_latency_ms"] = total_judge_latency
    resources["longmemeval_v2_local_judge_scoring_latency_ms"] = v2_judge_latency
    resources["summed_local_judge_scoring_latency_ms"] = total_judge_latency + v2_judge_latency
    resources["total_local_qwen_calls"] = int(resources["local_model_calls"]) + int(resources["local_judge_calls"])
    resources["longmemeval_local_judge_rows"] = len(scores)
    resources["longmemeval_v2_local_judge_rows"] = len(v2_local_scores)
    resources["longmemeval_v2_scorer_result_rows"] = len(v2_scores)

    report["limits"] = [
        "These are public benchmark datasets, not an authorized live-user distribution sample; results do not establish production-distribution quality or general safety.",
        "LongMemEval Memory primary scoring is normalized exact match plus answer-session retrieval recall. A supplementary score uses the pinned upstream answer-check prompt with a local qwen3:4b-instruct judge; it is not equivalent to the hosted GPT-4o judge or leaderboard result.",
        "LongMemEval-V2 is a recent work-in-progress preprint; 29 image-dependent items are excluded. Its LLM rubric judge ran locally, so results are not directly comparable to upstream hosted-judge leaderboard scores.",
        "Experience Cases were constructed from benchmark trajectories and deterministically marked validated inside the isolated harness. This does not evaluate human admission quality, full Runtime injection, real task reuse, freshness, or external distribution.",
        "Each task was run once at temperature 0. Benchmark answers and exact metrics can be sensitive to model version and fixture transformation.",
    ]
    report["attempt_history"] = [
        {"event_id": "evt:run:ccb861a365e6:000005", "outcome": "duplicate-session preflight rejected", "scores_retained": False},
        {"event_id": "evt:run:ccb861a365e6:000010", "outcome": "U+2028 JSONL parsing failed", "scores_retained": False},
        {"event_id": "evt:run:ccb861a365e6:000011", "outcome": "LF-only JSONL parser probe fixed reader", "scores_retained": False},
        {"event_id": "evt:run:ccb861a365e6:000014", "outcome": "initial qwen3:4b outputs hit 256-token ceiling; 341 partial questions and 682 response rows invalidated", "scores_retained": False},
        {"event_id": "evt:run:ccb861a365e6:000017", "outcome": "qwen3:4b-instruct answers hit 256-token ceiling; attempt outputs rejected", "scores_retained": False},
        {"event_id": "evt:run:ccb861a365e6:000019", "outcome": "V2 fixture class initialization order failed after V1 completed; retained valid V1 cache", "scores_retained": False},
        {"event_id": "evt:run:ccb861a365e6:000021", "outcome": "old V2 prompt hit 512-token ceiling after 292 question pairs; partial cache rejected", "scores_retained": False},
        {"event_id": "evt:run:ccb861a365e6:000023", "outcome": "old V2 prompt hit 1024-token ceiling; partial cache rejected", "scores_retained": False},
        {"event_id": "evt:run:ccb861a365e6:000025", "outcome": "old V2 prompt still hit 4096-token ceiling; all old-prompt V2 outputs invalidated", "scores_retained": False},
        {"event_id": "evt:run:ccb861a365e6:000027", "outcome": "choice-only format calibration passed under production retrieval path; calibration answers excluded from final data", "scores_retained": False},
        {"event_id": "evt:run:ccb861a365e6:000028", "outcome": "full V2 lane restarted from empty answer cache using calibrated choice-only prompt; all 422 pairs completed", "scores_retained": True},
    ]
    report["artifacts"]["longmemeval_upstream_prompt_local_judge"] = "included per item in longmemeval-items.jsonl"
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({
        "status": report["status"],
        "memory_upstream_prompt_local_judge": official_local,
        "local_judge_calls": resources["local_judge_calls"],
        "local_judge_tokens": resources["local_judge_tokens"],
        "total_local_qwen_calls": resources["total_local_qwen_calls"],
        "v1_item_rows": len(items),
        "v2_item_rows": report["completed_pairs"]["longmemeval_v2"],
        "report": str(REPORT),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
