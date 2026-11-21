#!/usr/bin/env python3
"""
BASS BLOCK Python Backend (stdio JSON-RPC).
Reads line-delimited JSON requests from stdin: {"id": 1, "method": "...", "params": {...}}
Writes line-delimited JSON responses to stdout: {"id": 1, "result": {...}}
"""
import json
import math
import os
import platform
import re
import statistics
import sys
from collections import Counter


def handle(method: str, params: dict):
    if method == "info":
        return {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "dataDir": os.environ.get("BB_DATA_DIR", ""),
        }

    if method == "analyze":
        text = str(params.get("text", ""))
        numbers = [float(x) for x in re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", text)]
        words = re.findall(r"[\w']+", text.lower())
        top_words = Counter(w for w in words if len(w) > 2).most_common(8)
        num_stats = None
        if numbers:
            num_stats = {
                "count": len(numbers),
                "sum": round(sum(numbers), 4),
                "mean": round(statistics.mean(numbers), 4),
                "median": round(statistics.median(numbers), 4),
                "min": min(numbers),
                "max": max(numbers),
                "stdev": round(statistics.stdev(numbers), 4) if len(numbers) > 1 else 0.0,
            }
        return {
            "lines": len(text.splitlines()) if text else 0,
            "words": len(words),
            "chars": len(text),
            "topWords": top_words,
            "numbers": num_stats,
        }

    raise ValueError(f"Unknown method: {method}")


def main():
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            result = handle(req.get("method", ""), req.get("params") or {})
            sys.stdout.write(json.dumps({"id": req_id, "result": result}) + "\n")
            sys.stdout.flush()
        except Exception as exc:
            sys.stdout.write(json.dumps({"id": req_id, "error": str(exc)}) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
