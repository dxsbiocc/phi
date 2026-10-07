#!/usr/bin/env python3
"""Report availability and versions of the managed Office Python packages."""

from __future__ import annotations

import importlib.metadata
import json

PACKAGES = (
    "markitdown",
    "openpyxl",
    "pypdf",
    "python-docx",
    "python-pptx",
    "reportlab",
    "xlsxwriter",
)


def main() -> int:
    versions: dict[str, str | None] = {}
    for package in PACKAGES:
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    missing = [package for package, version in versions.items() if version is None]
    print(
        json.dumps(
            {
                "environment": "phi:python@1",
                "ok": not missing,
                "packages": versions,
                "missing": missing,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
