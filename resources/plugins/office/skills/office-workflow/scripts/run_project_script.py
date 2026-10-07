#!/usr/bin/env python3
"""Run an existing project-local Python script inside the skill environment."""

from __future__ import annotations

import os
import runpy
import subprocess
import sys
from pathlib import Path

SUPPORTED_SUFFIXES = {".py", ".js", ".cjs", ".mjs"}


def project_script(value: str) -> Path:
    if Path(value).is_absolute():
        raise ValueError("script path must be relative to the current project")
    root = Path.cwd().resolve()
    target = (root / value).resolve(strict=True)
    try:
        target.relative_to(root)
    except ValueError as error:
        raise ValueError("script must stay inside the current project") from error
    if not target.is_file() or target.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise ValueError("script must be an existing .py, .js, .cjs, or .mjs file")
    return target


def node_environment() -> dict[str, str]:
    environment = os.environ.copy()
    managed_modules = str(Path(sys.prefix) / "lib" / "node_modules")
    existing = environment.get("NODE_PATH")
    environment["NODE_PATH"] = (
        os.pathsep.join([managed_modules, existing]) if existing else managed_modules
    )
    return environment


def main() -> int:
    if len(sys.argv) < 2:
        raise ValueError("usage: run_project_script.py <project-script> [args...]")
    target = project_script(sys.argv[1])
    forwarded = sys.argv[2:]
    if target.suffix.lower() == ".py":
        sys.argv = [str(target), *forwarded]
        runpy.run_path(str(target), run_name="__main__")
        return 0
    result = subprocess.run(
        ["node", str(target), *forwarded],
        env=node_environment(),
        check=False,
    )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
