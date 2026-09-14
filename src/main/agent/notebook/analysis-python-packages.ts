import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface AnalysisPythonPackageSummary {
  name: string
  kind: 'module' | 'package'
  source: 'third-party' | 'environment'
}

export interface AnalysisPythonPackageListResult {
  packages: AnalysisPythonPackageSummary[]
  status: 'ok' | 'error'
  message?: string
}

export interface PythonPackageListRunOptions {
  cwd: string
  input: string
  timeoutMs: number
}

export interface PythonPackageListRunResult {
  status: number | null
  stdout: string
  stderr: string
  errorCode?: string
}

export type PythonPackageListRunner = (
  command: string,
  args: string[],
  options: PythonPackageListRunOptions
) => PythonPackageListRunResult

const PACKAGE_LIST_TIMEOUT_MS = 5_000
const DEFAULT_MAX_PACKAGE_COUNT = 900
const PACKAGE_CACHE_TTL_MS = 5 * 60 * 1000

const PYTHON_PACKAGE_LIST_SCRIPT = `
import importlib.metadata
import json
import pkgutil
import sys

payload = json.loads(sys.stdin.read() or "{}")
limit = int(payload.get("limit") or 900)
third_party = set()

for dist in importlib.metadata.distributions():
    top_level = dist.read_text("top_level.txt") or ""
    if top_level:
        for line in top_level.splitlines():
            name = line.strip()
            if name:
                third_party.add(name)
        continue
    name = (dist.metadata.get("Name") or "").replace("-", "_").split(".")[0]
    if name:
        third_party.add(name)

seen = set()
packages = []
for module in pkgutil.iter_modules():
    name = module.name
    if not name or name.startswith("_") or not name.replace("_", "").isalnum():
        continue
    if name in seen:
        continue
    seen.add(name)
    packages.append({
        "name": name,
        "kind": "package" if module.ispkg else "module",
        "source": "third-party" if name in third_party else "environment",
    })

packages.sort(key=lambda item: (item["source"] != "third-party", item["name"].lower()))
print(json.dumps({"packages": packages[:limit]}, separators=(",", ":")))
`

type PackageCacheEntry = {
  expiresAt: number
  result: AnalysisPythonPackageListResult
}

const packageListCache = new Map<string, PackageCacheEntry>()

function pythonCommands(projectCwd: string): string[] {
  const localCandidates = [
    join(projectCwd, '.venv', 'bin', 'python'),
    join(projectCwd, 'venv', 'bin', 'python'),
    join(projectCwd, '.venv', 'Scripts', 'python.exe'),
    join(projectCwd, 'venv', 'Scripts', 'python.exe')
  ].filter((command) => existsSync(command))

  return [...localCandidates, 'python', 'python3']
}

function defaultPackageListRunner(
  command: string,
  args: string[],
  options: PythonPackageListRunOptions
): PythonPackageListRunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: 2 * 1024 * 1024
  })
  const error = result.error as NodeJS.ErrnoException | undefined
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    errorCode: error?.code
  }
}

function validPackageSummary(value: unknown): value is AnalysisPythonPackageSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.name === 'string' &&
    /^[A-Za-z][A-Za-z0-9_]*$/.test(candidate.name) &&
    (candidate.kind === 'module' || candidate.kind === 'package') &&
    (candidate.source === 'third-party' || candidate.source === 'environment')
  )
}

function parsePackageList(stdout: string): AnalysisPythonPackageSummary[] {
  const parsed = JSON.parse(stdout) as { packages?: unknown }
  if (!Array.isArray(parsed.packages)) return []
  return parsed.packages.filter(validPackageSummary)
}

function failureMessage(result: PythonPackageListRunResult): string {
  if (result.errorCode === 'ENOENT') return 'Python executable was not found.'
  return (result.stderr || result.stdout || 'Python package discovery failed.').trim().slice(0, 500)
}

export function clearAnalysisPythonPackageCache(): void {
  packageListCache.clear()
}

export function listAnalysisPythonPackages(
  input: { projectCwd: string; maxPackages?: number },
  options: { runner?: PythonPackageListRunner; now?: () => number } = {}
): AnalysisPythonPackageListResult {
  const now = options.now ?? (() => Date.now())
  const maxPackages = Math.max(50, Math.min(input.maxPackages ?? DEFAULT_MAX_PACKAGE_COUNT, 2_000))
  const cacheKey = `${input.projectCwd}:${maxPackages}`
  const cached = packageListCache.get(cacheKey)
  if (!options.runner && cached && cached.expiresAt > now()) {
    return cached.result
  }

  const runner = options.runner ?? defaultPackageListRunner
  let lastFailure = 'Python package discovery failed.'
  for (const command of pythonCommands(input.projectCwd)) {
    const result = runner(command, ['-c', PYTHON_PACKAGE_LIST_SCRIPT], {
      cwd: input.projectCwd,
      input: JSON.stringify({ limit: maxPackages }),
      timeoutMs: PACKAGE_LIST_TIMEOUT_MS
    })
    if (result.status !== 0) {
      lastFailure = failureMessage(result)
      continue
    }

    try {
      const listResult: AnalysisPythonPackageListResult = {
        packages: parsePackageList(result.stdout),
        status: 'ok'
      }
      if (!options.runner) {
        packageListCache.set(cacheKey, {
          expiresAt: now() + PACKAGE_CACHE_TTL_MS,
          result: listResult
        })
      }
      return listResult
    } catch {
      lastFailure = 'Python package discovery returned invalid JSON.'
    }
  }

  return {
    packages: [],
    status: 'error',
    message: lastFailure
  }
}
