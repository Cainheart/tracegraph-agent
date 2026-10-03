#!/usr/bin/env python3
"""Prepare licensed public LongMemEval and LongMemEval-V2 data for eval074.

The prepared files are temporary evaluation inputs. They deliberately omit
gold answers from retrieval candidates and retain only the fields needed by
the local retrieval and QA runners.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterator


def array_items(path: Path) -> Iterator[dict[str, Any]]:
    """Read a large top-level JSON array without holding parsed rows in RAM."""
    decoder = json.JSONDecoder()
    with path.open("r", encoding="utf-8") as handle:
        buffer = ""
        position = 0
        eof = False

        def fill() -> bool:
            nonlocal buffer, eof
            chunk = handle.read(2 * 1024 * 1024)
            if not chunk:
                eof = True
                return False
            buffer += chunk
            return True

        while position >= len(buffer) and fill():
            pass
        while position < len(buffer) and buffer[position].isspace():
            position += 1
        if position >= len(buffer) or buffer[position] != "[":
            raise ValueError("LongMemEval input must be a top-level JSON array")
        position += 1

        while True:
            while True:
                while position < len(buffer) and (buffer[position].isspace() or buffer[position] == ","):
                    position += 1
                if position < len(buffer) or eof:
                    break
                fill()
            if position < len(buffer) and buffer[position] == "]":
                return
            try:
                item, end = decoder.raw_decode(buffer, position)
            except json.JSONDecodeError:
                if eof:
                    raise
                fill()
                continue
            if not isinstance(item, dict):
                raise ValueError("LongMemEval rows must be objects")
            yield item
            position = end
            if position > 4 * 1024 * 1024:
                buffer = buffer[position:]
                position = 0


def text(value: Any) -> str:
    return value if isinstance(value, str) else "" if value is None else str(value)


def longmemeval(args: argparse.Namespace) -> None:
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    destination = output / "longmemeval-prepared.jsonl"
    rows = sessions = truncated = duplicate_session_references = 0
    with destination.open("w", encoding="utf-8") as target:
        for source in array_items(Path(args.longmemeval)):
            ids = source.get("haystack_session_ids", [])
            haystacks = source.get("haystack_sessions", [])
            if len(ids) != len(haystacks):
                raise ValueError(f"Session identity mismatch in {source.get('question_id')}")
            dates = source.get("haystack_dates", [])
            candidates = []
            candidates_by_id = {}
            for index, (session_id, transcript) in enumerate(zip(ids, haystacks, strict=True)):
                turns = transcript if isinstance(transcript, list) else [transcript]
                body = "\n".join(
                    f"{text(message.get('role', 'unknown'))}: {text(message.get('content'))}"
                    for message in turns
                    if isinstance(message, dict) and text(message.get("content")).strip()
                )
                session_date = text(dates[index]) if index < len(dates) else ""
                segments = [body[offset:offset + 3_900] for offset in range(0, len(body), 3_900)]
                segments = segments or ["Session has no text."]
                candidate = candidates_by_id.get(text(session_id))
                if candidate is not None:
                    if candidate["segments"] != segments:
                        raise ValueError(f"Conflicting transcript for repeated session id {session_id} in {source.get('question_id')}")
                    if session_date and session_date not in candidate["dates"]:
                        candidate["dates"].append(session_date)
                    duplicate_session_references += 1
                    continue
                candidate = {"session_id": text(session_id), "dates": [session_date] if session_date else [],
                             "segments": segments, "truncated": False}
                candidates.append(candidate)
                candidates_by_id[candidate["session_id"]] = candidate
                sessions += 1
            row = {
                "question_id": text(source.get("question_id")),
                "question_type": text(source.get("question_type")),
                "question": text(source.get("question")),
                "answer": text(source.get("answer")),
                "answer_session_ids": [text(value) for value in source.get("answer_session_ids", [])],
                "question_date": text(source.get("question_date")),
                "sessions": candidates,
            }
            # JSON Lines readers often treat U+2028/U+2029 as line breaks even
            # though they are valid characters inside JSON strings. Escape all
            # non-ASCII data so each prepared record remains exactly one LF row.
            target.write(json.dumps(row, ensure_ascii=True, separators=(",", ":")) + "\n")
            rows += 1
    print(json.dumps({"dataset": "LongMemEval_S cleaned", "rows": rows, "session_candidates": sessions,
                      "duplicate_session_references_collapsed": duplicate_session_references,
                      "truncated_session_candidates": truncated, "prepared_file": str(destination)}, ensure_ascii=False))


def trajectory_text(item: dict[str, Any]) -> tuple[str, bool]:
    chunks = [f"Goal: {text(item.get('goal'))}", f"Outcome: {text(item.get('outcome'))}"]
    states = [state for state in item.get("states", []) if isinstance(state, dict)]
    if len(states) > 8:
        selected_indices = sorted({round(index * (len(states) - 1) / 7) for index in range(8)})
        states = [states[index] for index in selected_indices]
    for index, state in enumerate(states, start=1):
        if not isinstance(state, dict):
            continue
        parts = [
            f"Action: {json_text(state.get('action'))}",
            f"Thought: {text(state.get('thought'))}",
        ]
        step = "\n".join(part for part in parts if part.strip())
        chunks.append(f"Sampled step {index}: {step[:900]}")
    body = "\n".join(chunk for chunk in chunks if chunk.strip())
    return body, False


def json_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def longmemeval_v2(args: argparse.Namespace) -> None:
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    small_map = json.loads(Path(args.v2_map).read_text(encoding="utf-8"))
    selected_questions = []
    for line in Path(args.v2_questions).open(encoding="utf-8"):
        question = json.loads(line)
        if question.get("image") is None:
            selected_questions.append({**question, "candidate_ids": small_map[question["id"]]})

    candidate_ids = {candidate_id for question in selected_questions for candidate_id in question["candidate_ids"]}
    candidates_path = output / "longmemeval-v2-candidates.jsonl"
    found: set[str] = set()
    truncated = 0
    with candidates_path.open("w", encoding="utf-8") as target:
        with Path(args.v2_trajectories).open(encoding="utf-8") as source:
            for line in source:
                trajectory = json.loads(line)
                identity = text(trajectory.get("id"))
                if identity not in candidate_ids:
                    continue
                body, clipped = trajectory_text(trajectory)
                truncated += int(clipped)
                target.write(json.dumps({
                    "id": identity,
                    "domain": text(trajectory.get("domain")),
                    "environment": text(trajectory.get("environment")),
                    "goal": text(trajectory.get("goal"))[:1_000],
                    "outcome": text(trajectory.get("outcome")),
                    "state_count": len(trajectory.get("states", [])),
                    "sampled_state_count": min(8, len(trajectory.get("states", []))),
                    "text": body,
                    "truncated": clipped,
                }, ensure_ascii=True, separators=(",", ":")) + "\n")
                found.add(identity)
    if found != candidate_ids:
        raise ValueError(f"LongMemEval-V2 candidate map missing {len(candidate_ids - found)} trajectory files")

    questions_path = output / "longmemeval-v2-text-questions.jsonl"
    with questions_path.open("w", encoding="utf-8") as target:
        for question in selected_questions:
            target.write(json.dumps(question, ensure_ascii=True, separators=(",", ":")) + "\n")
    print(json.dumps({"dataset": "LongMemEval-V2 small text-only", "questions": len(selected_questions),
                      "image_questions_excluded": len(small_map) - len(selected_questions),
                      "unique_candidates": len(candidate_ids), "truncated_candidates": truncated,
                      "questions_file": str(questions_path), "candidates_file": str(candidates_path)}, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--longmemeval", required=True)
    parser.add_argument("--v2-questions", required=True)
    parser.add_argument("--v2-map", required=True)
    parser.add_argument("--v2-trajectories", required=True)
    args = parser.parse_args()
    longmemeval(args)
    longmemeval_v2(args)


if __name__ == "__main__":
    main()
