#!/usr/bin/env python3
"""Apply the pinned LongMemEval-V2 official score functions locally."""

from __future__ import annotations

import argparse
import importlib.util
import json
import time
import urllib.request
from pathlib import Path
from typing import Any


MODEL = "qwen3:4b-instruct"
SEED = 20261003


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.open(encoding="utf-8") if line.strip()]


def load_scorer(path: Path):
    spec = importlib.util.spec_from_file_location("longmemeval_v2_official_metrics", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to import pinned upstream scorer: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def local_judge(messages: list[dict[str, str]], base_url: str) -> dict[str, Any]:
    payload = {
        "model": MODEL,
        "messages": messages,
        "stream": False,
        "think": False,
        "keep_alive": "30m",
        "format": "json",
        "options": {"temperature": 0, "seed": SEED, "num_ctx": 12_288, "num_predict": 512, "top_p": 1},
    }
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        body = json.loads(response.read())
    if body.get("done_reason") == "length":
        raise RuntimeError("Local qwen judge hit the 512-token output limit")
    content = body.get("message", {}).get("content")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("Local qwen judge returned no content")
    return {
        "content": content,
        "prompt_tokens": body.get("prompt_eval_count"),
        "completion_tokens": body.get("eval_count"),
        "duration_ms": round(body.get("total_duration", 0) / 1_000_000),
        "done_reason": body.get("done_reason"),
    }


def score_one(module, question: dict[str, Any], prediction: str, base_url: str) -> dict[str, Any]:
    spec = question["eval_function"]
    name = module.eval_name(spec)
    parsed = module.extract_boxed_answer(prediction)
    started = time.perf_counter()
    judge_model = None
    judge_stats: dict[str, Any] = {}
    if name == "llm_abstention_checker":
        messages = module._build_abstention_judge_messages(
            question_text=question["question"],
            reference_answer=str(question["answer"]),
            model_full_response=prediction,
            model_final_answer=parsed,
        )
        judged = local_judge(messages, base_url)
        label, _reason = module._parse_llm_binary_judgement(judged["content"])
        judge_stats = judged
        value = label == 1
        judge_model = MODEL
    elif name == "llm_gotchas_checker":
        messages = module._build_gotchas_judge_messages(
            question_text=question["question"],
            reference_answer=str(question["answer"]),
            model_full_response=prediction,
            model_final_answer=parsed,
        )
        judged = local_judge(messages, base_url)
        label, _reason = module._parse_llm_binary_judgement(judged["content"])
        judge_stats = judged
        value = label == 1
        judge_model = MODEL
    else:
        value = module.score_to_bool(module.eval_from_spec(spec, parsed, question["answer"]))
    return {
        "score": bool(value),
        "eval_function": name,
        "judge_model": judge_model,
        "judge_prompt_tokens": judge_stats.get("prompt_tokens"),
        "judge_completion_tokens": judge_stats.get("completion_tokens"),
        "judge_duration_ms": judge_stats.get("duration_ms"),
        "scoring_latency_ms": round((time.perf_counter() - started) * 1000),
        "scorer": "upstream LongMemEval-V2 qa_eval_metrics.py; local transport for upstream LLM rubric functions",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--questions", required=True)
    parser.add_argument("--responses", required=True)
    parser.add_argument("--scorer", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    args = parser.parse_args()

    scorer = load_scorer(Path(args.scorer))
    questions = {row["id"]: row for row in read_jsonl(Path(args.questions))}
    responses = {f"{row['question_id']}:{row['arm']}": row for row in read_jsonl(Path(args.responses))
                 if row.get("dataset") == "LongMemEval_V2"}
    cached_rows = read_jsonl(Path(args.cache))
    cache = {f"{row['question_id']}:{row['arm']}": row for row in cached_rows}
    completed = 0
    with Path(args.cache).open("a", encoding="utf-8") as output:
        for question_id, question in questions.items():
            for arm in ("control", "experience"):
                key = f"{question_id}:{arm}"
                if key in cache:
                    continue
                response = responses.get(key)
                if response is None:
                    raise RuntimeError(f"No local model response for {key}")
                scored = score_one(scorer, question, response["prediction"], args.ollama_url)
                row = {"question_id": question_id, "arm": arm, **scored}
                output.write(json.dumps(row, ensure_ascii=True) + "\n")
                output.flush()
                completed += 1
                if completed % 20 == 0:
                    print(json.dumps({"scored": completed, "cached": len(cache), "last": key}), flush=True)
    print(json.dumps({"status": "scored", "new_scores": completed, "total_scores": len(read_jsonl(Path(args.cache)))}))


if __name__ == "__main__":
    main()
