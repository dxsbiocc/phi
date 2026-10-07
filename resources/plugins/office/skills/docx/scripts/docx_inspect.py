#!/usr/bin/env python3
"""Return a bounded structural overview of a DOCX document as JSON."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from docx import Document

DEFAULT_MAX_PARAGRAPHS = 100
MAX_PARAGRAPHS = 500
MAX_TEXT_CHARS = 2000
MAX_TOTAL_TEXT_CHARS = 50_000
MAX_TABLES = 100
MAX_SECTIONS = 100
MAX_STYLES = 100
MAX_STYLE_CHARS = 100


def bounded_text(value: str, remaining: int) -> tuple[str, bool]:
    limit = min(MAX_TEXT_CHARS, remaining)
    if len(value) <= limit:
        return value, False
    return value[:limit], True


def bounded_style(paragraph: Any) -> tuple[str | None, bool]:
    if paragraph.style is None:
        return None, False
    name = paragraph.style.name
    return name[:MAX_STYLE_CHARS], len(name) > MAX_STYLE_CHARS


def paragraph_summary(paragraph: Any, index: int, remaining: int) -> dict[str, object]:
    text, truncated = bounded_text(paragraph.text, remaining)
    style, style_truncated = bounded_style(paragraph)
    return {
        "index": index,
        "text": text,
        "style": style,
        "styleTruncated": style_truncated,
        "runCount": len(paragraph.runs),
        "truncated": truncated,
    }


def table_summary(table: Any, index: int) -> dict[str, int]:
    rows = len(table.rows)
    columns = max((len(row.cells) for row in table.rows), default=0)
    return {"index": index, "rows": rows, "columns": columns}


def optional_inches(value: Any) -> float | None:
    return round(value.inches, 3) if value is not None else None


def section_summary(section: Any, index: int) -> dict[str, object]:
    return {
        "index": index,
        "topMarginInches": optional_inches(section.top_margin),
        "rightMarginInches": optional_inches(section.right_margin),
        "bottomMarginInches": optional_inches(section.bottom_margin),
        "leftMarginInches": optional_inches(section.left_margin),
        "headerParagraphs": len(section.header.paragraphs),
        "footerParagraphs": len(section.footer.paragraphs),
    }


def inspect_docx(path: Path, max_paragraphs: int) -> dict[str, object]:
    document = Document(path)
    paragraphs = []
    remaining = MAX_TOTAL_TEXT_CHARS
    for index, paragraph in enumerate(document.paragraphs[:max_paragraphs]):
        if remaining <= 0:
            break
        summary = paragraph_summary(paragraph, index, remaining)
        paragraphs.append(summary)
        remaining -= len(str(summary["text"]))
    text_truncated = any(bool(item["truncated"]) for item in paragraphs) or (
        remaining <= 0 and len(document.paragraphs) > len(paragraphs)
    )
    all_styles = sorted(
        {
            paragraph.style.name
            for paragraph in document.paragraphs
            if paragraph.style is not None
        }
    )
    styles_truncated = len(all_styles) > MAX_STYLES or any(
        len(name) > MAX_STYLE_CHARS for name in all_styles
    )
    tables = document.tables[:MAX_TABLES]
    sections = document.sections[:MAX_SECTIONS]
    return {
        "file": path.name,
        "paragraphCount": len(document.paragraphs),
        "tableCount": len(document.tables),
        "sectionCount": len(document.sections),
        "textTruncated": text_truncated,
        "paragraphsTruncated": len(document.paragraphs) > len(paragraphs) or text_truncated,
        "tablesTruncated": len(document.tables) > len(tables),
        "sectionsTruncated": len(document.sections) > len(sections),
        "stylesTruncated": styles_truncated,
        "paragraphs": paragraphs,
        "tables": [table_summary(item, index) for index, item in enumerate(tables)],
        "sections": [section_summary(item, index) for index, item in enumerate(sections)],
        "stylesUsed": [name[:MAX_STYLE_CHARS] for name in all_styles[:MAX_STYLES]],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--max_paragraphs", type=int, default=DEFAULT_MAX_PARAGRAPHS)
    args = parser.parse_args()
    if not 1 <= args.max_paragraphs <= MAX_PARAGRAPHS:
        parser.error(f"--max_paragraphs must be between 1 and {MAX_PARAGRAPHS}")
    return args


def main() -> int:
    args = parse_args()
    try:
        result = inspect_docx(args.input, args.max_paragraphs)
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
