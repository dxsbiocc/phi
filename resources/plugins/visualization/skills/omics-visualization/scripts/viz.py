#!/usr/bin/env python3
"""Omics visualization tools: examples, route, prepare, and render.

Success writes one JSON object to stdout and exits 0. Failure writes
{"error": "..."} to stdout and exits 1. Diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any, NoReturn

# The skill directory is read-only when bundled and must stay free of run leftovers:
# never write __pycache__ for the helper modules imported below.
sys.dont_write_bytecode = True


SKILL_ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
COMMON_R = os.path.join(SKILL_ROOT, "scripts", "lib", "common.R")
ROUTER = os.path.join(SKILL_ROOT, "scripts", "route_template.py")
QA_SCRIPT = os.path.join(SKILL_ROOT, "scripts", "qa_single_plot.py")

MAX_EXAMPLES = 4
DEFAULT_ROUTE_TOP = 4
MAX_ROUTE_TOP = 6
MAX_WHY = 3
ROUTER_TIMEOUT_SECONDS = 60
QA_TIMEOUT_SECONDS = 60
DEFAULT_RENDER_TIMEOUT_SECONDS = 180
MAX_RENDER_TIMEOUT_SECONDS = 900
ERROR_TAIL_CHARS = 1200
ROUTER_ERROR_CHARS = 800
MESSAGE_CHARS = 400
MAX_CAPTURE_CHARS = 200_000
MAX_SUGGESTIONS = 4
MAX_SCAN_DEPTH = 4
TITLE_MAX = 200

GENERIC_TERMS = frozenset(
    {
        "example",
        "examples",
        "preview",
        "previews",
        "show",
        "template",
        "templates",
        "plot",
        "figure",
        "示例",
        "模板",
        "预览",
        "图片",
        "图",
    }
)
OUTPUT_EXTENSIONS = {".png", ".pdf", ".svg"}
MEDIA_TYPES = {".png": "image/png", ".pdf": "application/pdf", ".svg": "image/svg+xml"}
EXAMPLE_DATA_EXTENSIONS = {".tsv", ".csv"}
NOT_ASSETS = {"plot.R", "preview.png"}

HEADER_LABEL = re.compile(r"^# ([A-Z][A-Za-z-]*(?: [a-z]+)*):[ \t]*(.*)$")
SECTION_MARKER = re.compile(r"^# (CONFIG|DATA PREPARATION|PLOT|SAVE)\b")
RULER = re.compile(r"^# -{10,}")
BOOTSTRAP = re.compile(r"^local\(\{\n[\s\S]*?^\}\)\n", re.MULTILINE)
INPUT_NAMES = re.compile(r"input_names\s*=\s*c\(([^)]*)\)")
QUOTED = re.compile(r"""["']([^"']+)["']""")
PARSE_IO = re.compile(r"parse_io_args\s*\(")
DEPENDENCY_TOKEN = re.compile(r"^[A-Za-z][A-Za-z0-9.]*$")
MISSING_PACKAGE = re.compile(r"there is no package called [‘'\"]([^’'\"]+)[’'\"]")
UTF8_LOCALE = re.compile(r"utf-?8", re.IGNORECASE)
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

_TEMPLATES: list[dict[str, Any]] | None = None


def dump_json(payload: object) -> str:
    """Compact JSON, matching JSON.stringify so stdout round-trips in the tests."""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def fail(message: str) -> NoReturn:
    sys.stdout.write(dump_json({"error": message}) + "\n")
    sys.stdout.flush()
    raise SystemExit(1)


def succeed(payload: dict[str, Any]) -> None:
    sys.stdout.write(dump_json(payload) + "\n")
    sys.stdout.flush()


def note(text: str) -> None:
    if text:
        sys.stderr.write(text if text.endswith("\n") else text + "\n")


class JsonArgumentParser(argparse.ArgumentParser):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs.setdefault("allow_abbrev", False)
        kwargs.setdefault("add_help", False)
        super().__init__(*args, **kwargs)

    def error(self, message: str) -> NoReturn:
        fail(message)


def clamp(value: int, low: int, high: int) -> int:
    return min(max(value, low), high)


def is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def json_number(value: object, default: int | float = 0) -> int | float:
    """JSON numbers that are whole stay ints, so stdout matches JSON.stringify."""
    if not is_number(value):
        return default
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def as_string(value: object, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def strings(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def string_map(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {key: item for key, item in value.items() if isinstance(item, str)}


def one_line(value: str) -> str:
    return re.sub(r"\s*\n\s*", " ", value).strip()


def node_resolve(cwd: str, requested: str) -> str:
    if os.path.isabs(requested):
        return os.path.normpath(requested)
    return os.path.normpath(os.path.join(cwd, requested))


def nearest_existing(path: str) -> str:
    current = path
    while not os.path.exists(current):
        parent = os.path.dirname(current)
        if parent == current:
            return current
        current = parent
    return current


def resolve_inside_project(cwd: str, requested: str, what: str) -> str:
    target = node_resolve(cwd, requested)
    real_cwd = os.path.realpath(cwd)
    anchor = nearest_existing(target)
    relative_tail = os.path.relpath(target, anchor)
    real_target = os.path.normpath(os.path.join(os.path.realpath(anchor), relative_tail))
    inside = os.path.relpath(real_target, real_cwd)
    if inside == ".." or inside.startswith(".." + os.sep) or os.path.isabs(inside):
        fail(
            f"{what} must be inside the project directory ({cwd}); got {requested}. "
            "Data files elsewhere can be read, but everything written goes in the project."
        )
    return target


def project_relative(cwd: str, path: str) -> str:
    relative = os.path.relpath(os.path.realpath(path), os.path.realpath(cwd))
    return relative.replace(os.sep, "/")


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def decode_output(data: bytes | str | None) -> str:
    if data is None:
        return ""
    text = data if isinstance(data, str) else data.decode("utf-8", "replace")
    if len(text) > MAX_CAPTURE_CHARS:
        return text[-MAX_CAPTURE_CHARS:]
    return text


class ProcessResult:
    def __init__(
        self,
        code: int | None,
        stdout: str,
        stderr: str,
        timed_out: bool,
        spawn_error: str | None,
    ) -> None:
        self.code = code
        self.stdout = stdout
        self.stderr = stderr
        self.timed_out = timed_out
        self.spawn_error = spawn_error


def run_process(
    argv: list[str],
    *,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    timeout: float,
) -> ProcessResult:
    try:
        completed = subprocess.run(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return ProcessResult(None, decode_output(exc.stdout), decode_output(exc.stderr), True, None)
    except OSError as exc:
        spawn = "ENOENT" if exc.errno == errno.ENOENT else (exc.strerror or str(exc))
        return ProcessResult(None, "", "", False, spawn)
    return ProcessResult(
        completed.returncode,
        decode_output(completed.stdout),
        decode_output(completed.stderr),
        False,
        None,
    )


def utf8_locale_env() -> dict[str, str]:
    effective = os.environ.get("LC_ALL") or os.environ.get("LC_CTYPE") or os.environ.get("LANG") or ""
    if UTF8_LOCALE.search(effective):
        return {}
    locale = "en_US.UTF-8" if sys.platform == "darwin" else "C.UTF-8"
    return {"LC_ALL": locale}


def r_environment() -> dict[str, str]:
    env = dict(os.environ)
    env.update(utf8_locale_env())
    env["OMICS_VISUALIZATION_SKILL_ROOT"] = SKILL_ROOT
    return env


def header_fields(lines: list[str]) -> dict[str, str]:
    fields: dict[str, str] = {}
    label: str | None = None
    parts: list[str] = []

    def flush() -> None:
        nonlocal label
        if label is not None:
            fields[label] = "\n".join(parts).strip()

    for line in lines:
        if line.startswith("#!"):
            continue
        if not line.startswith("#"):
            if line.strip() == "" and len(fields) + len(parts) > 0:
                break
            if line.strip() != "" and not line.startswith("#!"):
                break
            continue
        heading = HEADER_LABEL.match(line)
        if heading:
            flush()
            label = heading.group(1)
            parts = [heading.group(2)] if heading.group(2) else []
        elif label is not None:
            parts.append(re.sub(r"^#\s{0,2}", "", line, count=1))
    flush()
    return fields


def input_names_of(text: str) -> list[str]:
    match = INPUT_NAMES.search(text)
    if not match:
        return ["input"]
    quoted = QUOTED.findall(match.group(1))
    return quoted if quoted else ["input"]

def script_input_names(text: str) -> list[str] | None:
    if PARSE_IO.search(text):
        return input_names_of(text)
    return None


def section_map(lines: list[str]) -> dict[str, dict[str, Any]]:
    markers: list[tuple[str, int]] = []
    for index, line in enumerate(lines):
        match = SECTION_MARKER.match(line)
        if match is None:
            continue
        following = lines[index + 1] if index + 1 < len(lines) else ""
        if not RULER.match(following):
            continue
        markers.append((match.group(1), index))
    found: dict[str, dict[str, Any]] = {}
    for position, (name, index) in enumerate(markers):
        first = index + 2
        next_index = markers[position + 1][1] if position + 1 < len(markers) else None
        last = next_index - 2 if next_index is not None else len(lines) - 1
        while last > first and lines[last].strip() == "":
            last -= 1
        if last < first:
            continue
        found[name] = {
            "start_line": first + 1,
            "end_line": last + 1,
            "text": "\n".join(lines[first : last + 1]),
        }
    return found


def dependencies_of(header: dict[str, str]) -> list[str]:
    return [
        token
        for token in re.split(r"[\s,]+", header.get("Dependencies", ""))
        if DEPENDENCY_TOKEN.fullmatch(token) and token != "and"
    ]


def parse_template_source(text: str) -> dict[str, Any]:
    lines = text.split("\n")
    header = header_fields(lines)
    found = section_map(lines)
    source: dict[str, Any] = {
        "id": header.get("Template-ID", ""),
        "purpose": one_line(header.get("Purpose", "")),
        "input_names": input_names_of(text),
        "dependencies": dependencies_of(header),
        "title": one_line(header["Title"]) if header.get("Title") else "",
    }
    adaptation = header.get("Agent adaptation")
    if adaptation:
        source["adaptation"] = one_line(adaptation)
    assumptions = header.get("Scientific assumptions")
    if assumptions:
        source["assumptions"] = one_line(assumptions)
    if "CONFIG" in found:
        source["config"] = found["CONFIG"]
    if "DATA PREPARATION" in found:
        source["data_preparation"] = found["DATA PREPARATION"]
    if "PLOT" in found:
        source["plot"] = found["PLOT"]
    return source


def r_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def patch_bootstrap(text: str, common_r: str) -> str:
    match = BOOTSTRAP.search(text)
    if match is None or "common.R" not in match.group(0):
        raise ValueError("The template has no common.R bootstrap block to replace.")
    replacement = f"source({r_string(common_r)})\n"
    return text[: match.start()] + replacement + text[match.end() :]


def find_plot_scripts(directory: str, depth: int) -> list[str]:
    if depth > MAX_SCAN_DEPTH:
        return []
    found: list[str] = []
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return []
    for name in names:
        full = os.path.join(directory, name)
        try:
            if os.path.isdir(full):
                found.extend(find_plot_scripts(full, depth + 1))
            elif name == "plot.R" and os.path.isfile(full):
                found.append(full)
        except OSError:
            continue
    return found


def list_template_sources() -> list[dict[str, Any]]:
    global _TEMPLATES
    if _TEMPLATES is not None:
        return _TEMPLATES
    scripts = os.path.join(SKILL_ROOT, "scripts")
    sources: list[dict[str, Any]] = []
    if os.path.isdir(scripts):
        for path in find_plot_scripts(scripts, 0):
            try:
                text = open(path, encoding="utf-8").read()
            except OSError:
                continue
            source = parse_template_source(text)
            if not source["id"]:
                continue
            source["path"] = path
            sources.append(source)
    _TEMPLATES = sources
    return sources


def words(text: str) -> list[str]:
    return [part for part in re.split(r"[^a-z0-9]+", text.lower()) if part]


def edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for row in range(1, len(left) + 1):
        current = [row]
        for column in range(1, len(right) + 1):
            current.append(
                min(
                    previous[column] + 1,
                    current[column - 1] + 1,
                    previous[column - 1] + (0 if left[row - 1] == right[column - 1] else 1),
                )
            )
        previous = current
    return previous[len(right)]


def closest_names(typed: str, candidates: list[str], limit: int) -> list[str]:
    threshold = max(2, int(len(typed) * 0.4))
    input_words = set(words(typed))
    scored: list[tuple[int, bool, int, str]] = []
    for name in candidates:
        lower_input = typed.lower()
        lower_name = name.lower()
        shared = sum(1 for word in words(name) if word in input_words)
        contains = lower_input in lower_name or lower_name in lower_input
        distance = edit_distance(lower_input, lower_name)
        if shared > 0 or contains or distance <= threshold:
            scored.append((shared, contains, distance, name))
    scored.sort(key=lambda item: (-item[0], 0 if item[1] else 1, item[2], item[3]))
    return [item[3] for item in scored[:limit]]


def copy_entry(src: str, dst: str) -> None:
    if os.path.lexists(dst):
        if os.path.isdir(dst) and not os.path.islink(dst):
            shutil.rmtree(dst)
        else:
            os.remove(dst)
    if os.path.islink(src):
        os.symlink(os.readlink(src), dst)
        return
    if os.path.isdir(src):
        shutil.copytree(src, dst, symlinks=True)
        return
    shutil.copy2(src, dst, follow_symlinks=False)


def copy_assets(template_script: str, target_dir: str) -> list[str]:
    source_dir = os.path.dirname(template_script)
    names = sorted(
        name
        for name in os.listdir(source_dir)
        if name not in NOT_ASSETS and os.path.splitext(name)[1].lower() not in EXAMPLE_DATA_EXTENSIONS
    )
    for name in names:
        copy_entry(os.path.join(source_dir, name), os.path.join(target_dir, name))
    return names


def line_section(section: dict[str, Any] | None) -> dict[str, Any] | None:
    if section is None:
        return None
    return {"start_line": section["start_line"], "end_line": section["end_line"], "text": section["text"]}


def terms_for(purpose: str) -> list[str]:
    return [term for term in re.split(r"[\s,;，；。:：/]+", purpose.lower()) if term and term not in GENERIC_TERMS]


def score_template(template: dict[str, Any], terms: list[str]) -> int:
    if not terms:
        return 1
    labels = [
        str(template.get("id", "")),
        str(template.get("title", "")),
        str(template.get("family", "")),
    ]
    keywords = template.get("intent_keywords") or []
    labels.extend(str(keyword) for keyword in keywords)
    lowered = [label.lower() for label in labels]
    use_when = str(template.get("use_when") or "").lower()
    score = 0
    for term in terms:
        if any(term in label or label in term for label in lowered):
            score += 4
        elif term in use_when:
            score += 1
    return score


def is_installed_preview(path: str) -> bool:
    if not os.path.isabs(path) or os.path.basename(path) != "preview.png":
        return False
    try:
        root = os.path.realpath(SKILL_ROOT)
        real = os.path.realpath(path)
        parts = os.path.relpath(real, root).split(os.sep)
        return (
            len(parts) == 4
            and parts[0] == "scripts"
            and parts[3] == "preview.png"
            and os.path.isfile(real)
        )
    except OSError:
        return False


def installed_preview(template: dict[str, Any]) -> str | None:
    preview = template.get("preview")
    if not isinstance(preview, str) or not preview or os.path.isabs(preview):
        return None
    path = os.path.normpath(os.path.join(SKILL_ROOT, preview))
    if not is_installed_preview(path):
        return None
    return os.path.realpath(path)


def command_examples(purpose: str, top: int | None) -> None:
    purpose = purpose.strip()
    if not purpose:
        fail("purpose is required.")
    catalog_path = os.path.join(SKILL_ROOT, "references", "template_contracts.json")
    with open(catalog_path, encoding="utf-8") as handle:
        catalog = json.load(handle)
    templates = catalog.get("templates") if isinstance(catalog, dict) else None
    if not isinstance(templates, list):
        templates = []
    terms = terms_for(purpose)
    matches: list[tuple[int, int, dict[str, Any]]] = []
    for order, template in enumerate(templates):
        if not isinstance(template, dict):
            continue
        score = score_template(template, terms)
        if score > 0:
            matches.append((score, order, template))
    matches.sort(key=lambda item: (-item[0], item[1]))
    limit = clamp(top if top is not None else MAX_EXAMPLES, 1, MAX_EXAMPLES)
    candidates: list[dict[str, Any]] = []
    for _score, _order, template in matches:
        preview = installed_preview(template)
        if preview is None:
            continue
        template_id = str(template.get("id", ""))
        roles = template.get("roles") if isinstance(template.get("roles"), dict) else {}
        required = roles.get("required") if isinstance(roles, dict) else None
        if isinstance(required, list):
            required_roles = [item for item in required if isinstance(item, str)]
        else:
            required_roles = []
        candidates.append(
            {
                "template_id": template_id,
                "title": str(template.get("title", "")),
                "family": str(template.get("family", "")),
                "preview": preview,
                "preview_markdown": f"![{template_id}]({preview})",
                "use_when": str(template.get("use_when") or ""),
                "avoid_when": str(template.get("avoid_when") or ""),
                "required_roles": required_roles,
            }
        )
        if len(candidates) >= limit:
            break
    succeed(
        {
            "purpose": purpose,
            "source": "bundled-template-preview",
            "dataFitted": False,
            "totalMatches": len(matches),
            "candidates": candidates,
        }
    )


def compact_router_output(raw: object) -> dict[str, Any]:
    root = raw if isinstance(raw, dict) else {}
    profile = root.get("input_profile") if isinstance(root.get("input_profile"), dict) else {}
    numeric = set(strings(profile.get("numeric_columns")))
    sidecars_value = profile.get("sidecars")
    sidecars = list(sidecars_value.keys()) if isinstance(sidecars_value, dict) else []
    alignment_value = profile.get("sidecar_alignment")
    alignment = alignment_value.get("status") if isinstance(alignment_value, dict) else None
    recommendations = root.get("recommendations")
    if not isinstance(recommendations, list):
        recommendations = []
    candidates: list[dict[str, Any]] = []
    for rec in recommendations:
        if not isinstance(rec, dict):
            continue
        template_id = as_string(rec.get("id"))
        preview_value = rec.get("preview")
        preview = os.path.join(SKILL_ROOT, preview_value) if isinstance(preview_value, str) else ""
        candidates.append(
            {
                "template_id": template_id,
                "confidence": as_string(rec.get("confidence"), "unknown"),
                "score": json_number(rec.get("score")),
                "title": as_string(rec.get("title")),
                "why": strings(rec.get("rationale"))[:MAX_WHY],
                "risks": strings(rec.get("risks")),
                "use_when": as_string(rec.get("use_when")),
                "avoid_when": as_string(rec.get("avoid_when")),
                "required_roles": strings(rec.get("required_roles")),
                "role_mapping": string_map(rec.get("role_mapping")),
                "preview": preview,
                "preview_markdown": f"![{template_id}]({preview})" if preview else "",
            }
        )
    payload: dict[str, Any] = {
        "rows": json_number(profile.get("row_count")),
        "columns": [
            {"name": name, "type": "number" if name in numeric else "text"}
            for name in strings(profile.get("columns"))
        ],
        "roles": string_map(profile.get("role_mapping")),
    }
    if sidecars:
        payload["sidecars"] = sidecars
    if isinstance(alignment, str) and alignment != "not_checked":
        payload["sidecar_alignment"] = alignment
    return {"input": payload, "candidates": candidates}


def command_route(
    data_path: str, purpose: str, mode: str, top: int | None, sidecar_dir: str | None
) -> None:
    data_path = data_path.strip()
    purpose = purpose.strip()
    if not data_path or not purpose:
        fail("data_path and purpose are required.")
    if not os.path.isfile(data_path):
        fail(f"The data table was not found: {data_path}")
    limit = clamp(top if top is not None else DEFAULT_ROUTE_TOP, 1, MAX_ROUTE_TOP)
    argv = [
        sys.executable,
        ROUTER,
        "--input",
        data_path,
        "--query",
        purpose,
        "--mode",
        mode,
        "--top",
        str(limit),
    ]
    if sidecar_dir and sidecar_dir.strip():
        argv.extend(["--sidecar-dir", sidecar_dir.strip()])
    argv.append("--json")
    outcome = run_process(argv, timeout=ROUTER_TIMEOUT_SECONDS)
    if outcome.spawn_error:
        fail(
            f"python3 was not found ({outcome.spawn_error}). "
            "The template router needs Python 3 on PATH; report this as a missing dependency."
        )
    if outcome.timed_out or outcome.code != 0:
        note(outcome.stderr)
        detail = "timed out" if outcome.timed_out else outcome.stderr.strip()[-ROUTER_ERROR_CHARS:]
        fail(f"The template router failed: {detail}")
    try:
        parsed = json.loads(outcome.stdout)
    except json.JSONDecodeError:
        note(outcome.stderr)
        fail("The template router returned output that is not JSON.")
    if outcome.stderr:
        note(outcome.stderr)
    succeed(compact_router_output(parsed))


def command_prepare(template_id: str, workdir: str, reset: bool) -> None:
    template_id = template_id.strip()
    workdir = workdir.strip()
    if not template_id or not workdir:
        fail("template_id and workdir are required.")
    templates = list_template_sources()
    template = next((candidate for candidate in templates if candidate["id"] == template_id), None)
    if template is None:
        close = closest_names(template_id, [candidate["id"] for candidate in templates], MAX_SUGGESTIONS)
        suggestion = f" Closest: {', '.join(close)}." if close else ""
        fail(
            f'There is no template "{template_id}".{suggestion}'
            " Use viz_route to find one for the data; do not guess template ids."
        )
    directory = resolve_inside_project(os.getcwd(), workdir, "The working directory")
    script = os.path.join(directory, "plot.R")
    existing = os.path.exists(script) and not reset
    assets: list[str] = []
    if not existing:
        os.makedirs(directory, exist_ok=True)
        original = open(template["path"], encoding="utf-8").read()
        try:
            patched = patch_bootstrap(original, COMMON_R)
        except ValueError as exc:
            fail(str(exc))
        with open(script, "w", encoding="utf-8") as handle:
            handle.write(patched)
        assets = copy_assets(template["path"], directory)
    current = parse_template_source(open(script, encoding="utf-8").read())
    names = template["input_names"]
    result: dict[str, Any] = {"template_id": template["id"], "script": script}
    if existing:
        result["existing"] = True
    if assets:
        result["assets"] = assets
    result["purpose"] = template["purpose"]
    result["inputs"] = names
    joined = " ".join(f"<{name}>" for name in names)
    result["run"] = f"Rscript {script} {joined} <output>"
    result["dependencies"] = template["dependencies"]
    if template.get("adaptation"):
        result["adaptation"] = template["adaptation"]
    if template.get("assumptions"):
        result["assumptions"] = template["assumptions"]
    config = line_section(current.get("config"))
    data_preparation = line_section(current.get("data_preparation"))
    if config:
        result["config"] = config
    if data_preparation:
        result["data_preparation"] = data_preparation
    plot = current.get("plot")
    if isinstance(plot, dict):
        result["plot"] = {"start_line": plot["start_line"], "end_line": plot["end_line"]}
    succeed(result)


def png_size(path: str) -> tuple[int, int] | None:
    try:
        with open(path, "rb") as handle:
            data = handle.read(24)
    except OSError:
        return None
    if len(data) < 24 or not data.startswith(PNG_SIGNATURE) or data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", data[16:24])
    if width < 1 or height < 1:
        return None
    return width, height


def summarize_qa(stdout: str) -> dict[str, Any]:
    try:
        parsed = json.loads(stdout)
    except json.JSONDecodeError:
        return {"qa": {"ok": False, "failed": ["qa_unavailable"]}}
    checks = parsed.get("checks") if isinstance(parsed, dict) else None
    if isinstance(checks, list):
        records = [check for check in checks if isinstance(check, dict)]
    else:
        records = []
    failed = [str(check.get("name")) for check in records if check.get("ok") is False]
    dimensions = next((check for check in records if isinstance(check.get("format"), str)), None)
    summary: dict[str, Any] = {
        "qa": {"ok": isinstance(parsed, dict) and parsed.get("ok") is True, "failed": failed}
    }
    if dimensions is not None:
        summary["format"] = str(dimensions["format"])
        width = dimensions.get("width")
        height = dimensions.get("height")
        if is_number(width):
            summary["width"] = json_number(width)
        if is_number(height):
            summary["height"] = json_number(height)
    return summary


def r_failure(stderr: str) -> str:
    missing = list(dict.fromkeys(MISSING_PACKAGE.findall(stderr)))
    tail = stderr.strip()[-ERROR_TAIL_CHARS:]
    if missing:
        head = (
            f"R package(s) not installed: {', '.join(missing)}. "
            "Do not install packages; report the missing dependency.\n"
        )
    else:
        head = "R failed.\n"
    return head + tail


def figure_title(script_path: str, output_path: str) -> str:
    try:
        source = parse_template_source(open(script_path, encoding="utf-8").read())
        title = str(source.get("title") or "").strip()
    except OSError:
        title = ""
    if not title:
        title = os.path.basename(output_path)
    return title[:TITLE_MAX]


def write_descriptor(
    *,
    cwd: str,
    script_path: str,
    inputs: list[str],
    output_path: str,
    timeout_seconds: int | None,
) -> None:
    extension = os.path.splitext(output_path)[1].lower()
    figure: dict[str, Any] = {"format": extension[1:]}
    if extension == ".png":
        size = png_size(output_path)
        if size is not None:
            figure["widthPx"] = size[0]
            figure["heightPx"] = size[1]
    provenance: dict[str, Any] = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "tool": "viz_render",
        "skill": "omics-visualization",
        "inputs": [
            {"path": project_relative(cwd, path), "sha256": sha256_file(path)} for path in inputs
        ],
        "script": project_relative(cwd, script_path),
    }
    if timeout_seconds is not None:
        provenance["parameters"] = {"timeout_seconds": timeout_seconds}
    descriptor = {
        "contractVersion": "1.0.0",
        "kind": "figure",
        "file": os.path.basename(output_path),
        "mediaType": MEDIA_TYPES[extension],
        "title": figure_title(script_path, output_path),
        "figure": figure,
        "provenance": provenance,
    }
    target = output_path + ".phi-artifact.json"
    temporary = target + ".tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(descriptor, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, target)
    except Exception:
        if os.path.exists(temporary):
            try:
                os.remove(temporary)
            except OSError:
                pass
        raise


def command_render(script: str, inputs: list[str], output: str, timeout_seconds: int | None) -> None:
    script = script.strip()
    output = output.strip()
    if not script or not output:
        fail("script and output are required.")
    cleaned = [item.strip() for item in inputs if item.strip()]
    if not cleaned:
        fail("At least one input table is required.")
    cwd = os.getcwd()
    script_path = resolve_inside_project(cwd, script, "The script")
    output_path = resolve_inside_project(cwd, output, "The output file")
    extension = os.path.splitext(output_path)[1].lower()
    if extension not in OUTPUT_EXTENSIONS:
        fail("The output file must be a .png, .pdf or .svg file.")
    if not os.path.exists(script_path):
        fail(f"The script was not found: {script_path}. Create it with viz_prepare.")
    resolved_inputs = [node_resolve(cwd, item) for item in cleaned]
    missing = [item for item in resolved_inputs if not os.path.exists(item)]
    if missing:
        fail(f"Input file(s) not found: {', '.join(missing)}")
    expected = script_input_names(open(script_path, encoding="utf-8").read())
    if expected is not None and len(expected) != len(resolved_inputs):
        fail(
            f"This template expects {len(expected)} input(s): {', '.join(expected)}; "
            f"got {len(resolved_inputs)}."
        )
    parent = os.path.dirname(output_path) or cwd
    os.makedirs(parent, exist_ok=True)
    seconds = clamp(
        timeout_seconds if timeout_seconds is not None else DEFAULT_RENDER_TIMEOUT_SECONDS,
        1,
        MAX_RENDER_TIMEOUT_SECONDS,
    )
    ran = run_process(
        ["Rscript", script_path, *resolved_inputs, output_path],
        cwd=os.path.dirname(script_path),
        env=r_environment(),
        timeout=seconds,
    )
    if ran.spawn_error:
        fail(
            f"Rscript was not found ({ran.spawn_error}). "
            "Rendering needs R on PATH; report this as a missing dependency and do not install it."
        )
    if ran.timed_out:
        note(ran.stderr)
        fail(f"R timed out after {seconds} s.")
    if ran.code != 0:
        note(ran.stderr)
        fail(r_failure(ran.stderr))
    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        note(ran.stderr)
        fail(
            f"R finished but did not write {output_path}. "
            f"Check the output path the script uses ({os.path.basename(script_path)} "
            "takes it as its last argument)."
        )
    qa = run_process(
        [sys.executable, QA_SCRIPT, output_path, "--json"],
        timeout=QA_TIMEOUT_SECONDS,
    )
    if qa.spawn_error or qa.timed_out:
        summary: dict[str, Any] = {"qa": {"ok": False, "failed": ["qa_unavailable"]}}
    else:
        summary = summarize_qa(qa.stdout)
    if ran.stderr:
        note(ran.stderr)
    if qa.stderr:
        note(qa.stderr)
    try:
        write_descriptor(
            cwd=cwd,
            script_path=script_path,
            inputs=resolved_inputs,
            output_path=output_path,
            timeout_seconds=seconds if timeout_seconds is not None else None,
        )
    except Exception as exc:
        fail(f"Could not write the artifact descriptor: {exc}")
    messages = ran.stderr.strip()[-MESSAGE_CHARS:]
    result: dict[str, Any] = {
        "ok": True,
        "output": output_path,
        "bytes": os.path.getsize(output_path),
        "qa": summary["qa"],
    }
    if "format" in summary:
        result["format"] = summary["format"]
    if "width" in summary:
        result["width"] = summary["width"]
    if "height" in summary:
        result["height"] = summary["height"]
    if messages:
        result["messages"] = messages
    result["artifacts"] = [project_relative(cwd, output_path)]
    succeed(result)


def build_parser() -> JsonArgumentParser:
    parser = JsonArgumentParser(prog="viz.py")
    commands = parser.add_subparsers(dest="command", required=True, parser_class=JsonArgumentParser)
    examples = commands.add_parser("examples")
    examples.add_argument("--purpose", required=True)
    examples.add_argument("--top", type=int)
    route = commands.add_parser("route")
    route.add_argument("--data_path", required=True)
    route.add_argument("--purpose", required=True)
    route.add_argument("--mode", choices=("preview", "publication"), default="preview")
    route.add_argument("--top", type=int)
    route.add_argument("--sidecar_dir")
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--template_id", required=True)
    prepare.add_argument("--workdir", required=True)
    prepare.add_argument("--reset", action="store_true")
    render = commands.add_parser("render")
    render.add_argument("--script", required=True)
    render.add_argument("--inputs", action="append", required=True)
    render.add_argument("--output", required=True)
    render.add_argument("--timeout_seconds", type=int)
    return parser


def reject_unknown_flags(argv: list[str]) -> None:
    """Report an unknown option before a missing required one.

    Subparsers validate required flags before leftover options, so `--help`
    would otherwise be swallowed. The message matches argparse.
    """
    if not argv or argv[0].startswith("-"):
        return
    known = {
        "examples": {"--purpose", "--top"},
        "route": {"--data_path", "--purpose", "--mode", "--top", "--sidecar_dir"},
        "prepare": {"--template_id", "--workdir", "--reset"},
        "render": {"--script", "--inputs", "--output", "--timeout_seconds"},
    }.get(argv[0])
    if known is None:
        return
    for token in argv[1:]:
        if token == "--":
            break
        if token.startswith("-") and token.split("=", 1)[0] not in known:
            fail(f"unrecognized arguments: {token}")


def main(argv: list[str] | None = None) -> None:
    args_list = list(sys.argv[1:] if argv is None else argv)
    reject_unknown_flags(args_list)
    args = build_parser().parse_args(args_list)
    if args.command == "examples":
        command_examples(args.purpose, args.top)
        return
    if args.command == "route":
        command_route(args.data_path, args.purpose, args.mode, args.top, args.sidecar_dir)
        return
    if args.command == "prepare":
        command_prepare(args.template_id, args.workdir, args.reset)
        return
    if args.command == "render":
        command_render(args.script, args.inputs if args.inputs else [], args.output, args.timeout_seconds)
        return
    fail(f"unknown command {args.command}")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        fail(str(exc))
