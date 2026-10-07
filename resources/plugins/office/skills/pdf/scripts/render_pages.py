#!/usr/bin/env python3
"""Render PDF pages to project-local PNG files with managed Poppler."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_DPI = 150
MIN_DPI = 72
MAX_DPI = 300


def existing_project_path(value: Path) -> tuple[Path, Path]:
    root = Path.cwd().resolve()
    target = value.resolve(strict=True)
    try:
        target.relative_to(root)
    except ValueError as error:
        raise ValueError("path must stay inside the current project") from error
    return root, target


def output_destination(value: Path) -> tuple[Path, Path]:
    root = Path.cwd().resolve()
    lexical_target = Path(os.path.abspath(value))
    try:
        relative_target = lexical_target.relative_to(root)
    except ValueError as error:
        raise ValueError("output directory must stay inside the current project") from error
    if not relative_target.parts:
        raise ValueError("output directory must not be the project root")

    parent = root
    for part in relative_target.parts[:-1]:
        parent /= part
        if parent.is_symlink():
            raise ValueError("output directory parent must not contain symlinks")
        if not parent.is_dir():
            raise ValueError("output directory parent must already exist")

    resolved_parent = parent.resolve(strict=True)
    try:
        resolved_parent.relative_to(root)
    except ValueError as error:
        raise ValueError("output directory parent must stay inside the current project") from error
    destination = resolved_parent / relative_target.name
    if os.path.lexists(destination):
        raise ValueError("output directory must not already exist")
    return root, destination


def page_number(path: Path) -> int:
    match = re.search(r"-(\d+)\.png$", path.name)
    return int(match.group(1)) if match else 0


def render_pages(input_path: Path, output_dir: Path, dpi: int) -> dict[str, object]:
    root, source = existing_project_path(input_path)
    if source.suffix.lower() != ".pdf" or not source.is_file():
        raise ValueError("input must be an existing PDF file")
    _, destination = output_destination(output_dir)
    staging = Path(
        tempfile.mkdtemp(
            prefix=f".{destination.name}.tmp-",
            dir=destination.parent,
        )
    )
    try:
        prefix = staging / "page"
        result = subprocess.run(
            ["pdftoppm", "-png", "-r", str(dpi), str(source), str(prefix)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "managed PDF rendering failed")
        images = sorted(staging.glob("page-*.png"), key=page_number)
        if not images or any(path.is_symlink() or not path.is_file() for path in images):
            raise RuntimeError("managed PDF rendering produced no page images")
        if os.path.lexists(destination):
            raise ValueError("output directory must not already exist")
        image_names = [path.name for path in images]
        staging.rename(destination)
        return {
            "file": source.name,
            "pageCount": len(image_names),
            "dpi": dpi,
            "images": [
                (destination / name).relative_to(root).as_posix()
                for name in image_names
            ],
        }
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output_dir", required=True, type=Path)
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    args = parser.parse_args()
    if not MIN_DPI <= args.dpi <= MAX_DPI:
        parser.error(f"--dpi must be between {MIN_DPI} and {MAX_DPI}")
    return args


def main() -> int:
    args = parse_args()
    try:
        result = render_pages(args.input, args.output_dir, args.dpi)
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
