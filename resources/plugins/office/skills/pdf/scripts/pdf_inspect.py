#!/usr/bin/env python3
"""Return a bounded structural overview of a PDF as JSON."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pypdf import PdfReader

DEFAULT_MAX_PAGES = 50
MAX_PAGES = 500
MAX_METADATA_ENTRIES = 50
MAX_METADATA_KEY_CHARS = 100
MAX_METADATA_VALUE_CHARS = 500
MAX_METADATA_TOTAL_CHARS = 10_000


def bounded_metadata(reader: PdfReader) -> tuple[dict[str, str], bool]:
    source = reader.metadata or {}
    metadata: dict[str, str] = {}
    remaining = MAX_METADATA_TOTAL_CHARS
    truncated = len(source) > MAX_METADATA_ENTRIES
    for index, (raw_key, raw_value) in enumerate(source.items()):
        if index >= MAX_METADATA_ENTRIES or remaining <= 0:
            truncated = True
            break
        full_key = str(raw_key).lstrip("/")
        key_limit = min(MAX_METADATA_KEY_CHARS, remaining)
        key = full_key[:key_limit]
        remaining -= len(key)
        full_value = str(raw_value)
        value_limit = min(MAX_METADATA_VALUE_CHARS, remaining)
        value = full_value[:value_limit]
        remaining -= len(value)
        truncated = truncated or len(full_key) > len(key) or len(full_value) > len(value)
        if key in metadata:
            truncated = True
            continue
        metadata[key] = value
    return metadata, truncated


def inspect_pdf(path: Path, max_pages: int) -> dict[str, object]:
    reader = PdfReader(path)
    if reader.is_encrypted:
        return {
            "file": path.name,
            "pageCount": None,
            "encrypted": True,
            "pagesTruncated": False,
            "pages": [],
            "metadata": {},
            "metadataTruncated": False,
        }
    pages = []
    for index, page in enumerate(reader.pages[:max_pages]):
        text = page.extract_text() or ""
        pages.append({"index": index, "textCharacters": len(text)})
    metadata, metadata_truncated = bounded_metadata(reader)
    return {
        "file": path.name,
        "pageCount": len(reader.pages),
        "encrypted": False,
        "pagesTruncated": len(reader.pages) > len(pages),
        "pages": pages,
        "metadata": metadata,
        "metadataTruncated": metadata_truncated,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--max_pages", type=int, default=DEFAULT_MAX_PAGES)
    args = parser.parse_args()
    if not 1 <= args.max_pages <= MAX_PAGES:
        parser.error(f"--max_pages must be between 1 and {MAX_PAGES}")
    return args


def main() -> int:
    args = parse_args()
    try:
        result = inspect_pdf(args.input, args.max_pages)
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
