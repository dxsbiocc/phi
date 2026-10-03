#!/usr/bin/env python3
"""Scores the URL-fetch evaluation output: per-arm accuracy (all expected facts present in the final
answer), model calls, tool calls, failed tool calls, tool result size and wall time.

Usage: python3 scripts/eval/db-vs-fetch-score.py <results.jsonl> [--detail]
"""
import json
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

TASKS_FILE = Path(__file__).with_name('db-vs-fetch-tasks.ts')


def load_expectations() -> dict[str, list[str]]:
    text = TASKS_FILE.read_text(encoding='utf-8')
    expectations = {}
    for match in re.finditer(r"id: '(T\d+)'.*?expect: \[(.*?)\]", text, re.S):
        expectations[match.group(1)] = re.findall(r"'([^']*)'", match.group(2))
    return expectations


def normalise(text: str) -> str:
    return re.sub(r'[\s,_]', '', text.lower()).replace('x-raydiffraction', 'x-ray')


def fact_present(fact: str, answer: str) -> bool:
    answer_n = normalise(answer)
    fact_n = normalise(fact)
    if fact_n in answer_n:
        return True
    # 43044292 may be printed as 43,044,292; biological_process as "biological process".
    return fact_n.replace('-', '') in answer_n.replace('-', '')


def main() -> None:
    path = sys.argv[1]
    detail = '--detail' in sys.argv
    expectations = load_expectations()
    rows = [json.loads(line) for line in open(path, encoding='utf-8') if line.strip()]
    by_arm: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        facts = expectations.get(row['task'], [])
        missing = [f for f in facts if not fact_present(f, row.get('finalText', ''))]
        row['correct'] = not missing and not row.get('error')
        row['missing'] = missing
        by_arm[row['arm']].append(row)

    header = f"{'arm':<12} {'runs':>4} {'correct':>8} {'calls':>6} {'tools':>6} {'failed':>7} {'resultKB':>9} {'sec':>6} {'sec p90':>8}"
    print(header)
    for arm, arm_rows in by_arm.items():
        n = len(arm_rows)
        mean = lambda key: statistics.mean(key(r) for r in arm_rows)  # noqa: E731
        secs = sorted(r['elapsedMs'] / 1000 for r in arm_rows)
        p90 = secs[min(len(secs) - 1, int(0.9 * len(secs)))]
        print(
            f"{arm:<12} {n:>4} {sum(r['correct'] for r in arm_rows):>4}/{n:<3}"
            f" {mean(lambda r: r['modelCalls']):>6.1f}"
            f" {mean(lambda r: len(r['tools'])):>6.1f}"
            f" {mean(lambda r: sum(t['error'] for t in r['tools'])):>7.1f}"
            f" {mean(lambda r: sum(t['chars'] for t in r['tools'])) / 1024:>9.1f}"
            f" {mean(lambda r: r['elapsedMs'] / 1000):>6.1f} {p90:>8.1f}"
        )

    if detail:
        print()
        for task in sorted({r['task'] for r in rows}):
            cells = []
            for arm in by_arm:
                runs = [r for r in by_arm[arm] if r['task'] == task]
                marks = ''.join('✓' if r['correct'] else '✗' for r in runs)
                tools = '/'.join(str(len(r['tools'])) for r in runs)
                cells.append(f"{arm}:{marks} ({tools} tools)")
            print(f"{task}  " + '   '.join(cells))
        print()
        for row in rows:
            if not row['correct']:
                print(f"✗ {row['arm']} {row['task']} rep{row['rep']} missing={row['missing']} error={row.get('error')}")


if __name__ == '__main__':
    main()
