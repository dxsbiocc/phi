#!/usr/bin/env python3
"""Extract bounded document text with markitdown from the managed environment."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

MAX_TEXT_CHARS = 100_000


def project_file(value: Path) -> tuple[Path, Path]:
    root = Path.cwd().resolve()
    source = value.resolve(strict=True)
    try:
        source.relative_to(root)
    except ValueError as error:
        raise ValueError("input must stay inside the current project") from error
    if not source.is_file():
        raise ValueError("input must be an existing file")
    return root, source


def extract_text(path: Path) -> dict[str, object]:
    _, source = project_file(path)
    result = subprocess.run(
        [sys.executable, "-m", "markitdown", str(source)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "managed text extraction failed")
    return {
        "file": source.name,
        "text": result.stdout[:MAX_TEXT_CHARS],
        "truncated": len(result.stdout) > MAX_TEXT_CHARS,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        result = extract_text(args.input)
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
