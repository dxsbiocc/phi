import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, resolve } from 'node:path'

import type { PhiExtensionHost } from '../host'

const PROBE_TIMEOUT_MS = 20_000
const PROBE_MAX_BUFFER = 256 * 1024

/** Minimal execFile contract so tests can observe and stub process probes. */
export interface ProbeRunOptions {
  env: NodeJS.ProcessEnv
  cwd: string
  timeout: number
  maxBuffer: number
  shell: false
}

export interface ProbeResult {
  stdout: string
  stderr: string
}

export type ProbeRunner = (
  file: string,
  args: readonly string[],
  options: ProbeRunOptions
) => Promise<ProbeResult>

export interface CommandProbeResult {
  name: string
  path: string | null
}

export interface ModuleProbeResult {
  name: string
  found: boolean
  version: string | null
  unchecked?: boolean
}

export interface PythonProbeResult {
  checked: boolean
  interpreter: string | null
  executable: string | null
  version: string | null
  modules: ModuleProbeResult[]
  error?: string
}

export interface RPackageProbeResult {
  name: string
  found: boolean
  version: string | null
  unchecked?: boolean
}

export interface RProbeResult {
  checked: boolean
  interpreter: string | null
  version: string | null
  packages: RPackageProbeResult[]
  error?: string
}

export interface CheckEnvironmentDetails {
  commands: CommandProbeResult[]
  python?: PythonProbeResult
  r?: RProbeResult
}

export interface CheckEnvironmentRequest {
  commands: readonly string[]
  python_modules: readonly string[]
  r_packages: readonly string[]
}

// Same sys.path as the plan steps' python (user site, PYTHONPATH), minus the
// working directory entry so a project file cannot shadow a probed module.
const PYTHON_PROBE_SCRIPT = `
import sys
if sys.path and sys.path[0] == '':
    del sys.path[0]
import importlib.metadata
import importlib.util
import json

def probe(name):
    try:
        found = importlib.util.find_spec(name) is not None
    except Exception:
        found = False
    version = None
    if found:
        try:
            version = importlib.metadata.version(name.split('.')[0])
        except Exception:
            version = None
    return {"found": found, "version": version}

print(json.dumps({
    "python": sys.version.split()[0],
    "executable": sys.executable,
    "modules": {name: probe(name) for name in sys.argv[1:]},
}))
`.trim()

const R_PROBE_EXPRESSION = `
args <- commandArgs(trailingOnly=TRUE)
cat("R\\t", R.version.string, "\\n", sep="")
for (p in args) {
  found <- nzchar(system.file(package=p))
  version <- ""
  if (found) {
    version <- tryCatch(as.character(packageVersion(p)), error=function(e) "")
  }
  cat(p, "\\t", if (found) "true" else "false", "\\t", version, "\\n", sep="")
}
`.trim()

export const defaultProbeRunner: ProbeRunner = (file, args, options) =>
  new Promise((resolveRun, rejectRun) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        rejectRun(error)
        return
      }
      resolveRun({ stdout, stderr })
    })
  })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function selectedEnvironment(host: PhiExtensionHost): NodeJS.ProcessEnv {
  const binding = host.environmentBinding()
  return { ...(binding ? binding.variables : host.hostEnvironment()) }
}

export function pathValue(environment: NodeJS.ProcessEnv): string | undefined {
  return environment.PATH ?? environment.Path
}

export async function resolveCommand(
  name: string,
  path: string | undefined
): Promise<string | null> {
  if (!path) return null
  for (const entry of path.split(delimiter)) {
    if (!entry) continue
    const candidate = resolve(entry, name)
    try {
      if (!(await stat(candidate)).isFile()) continue
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Missing, unreadable, or non-executable candidates are simply skipped.
    }
  }
  return null
}

function failureText(section: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const record = isRecord(error) ? error : undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  if (
    record?.killed === true ||
    code === 'ETIMEDOUT' ||
    /timed?\s*out|timeout|abort/i.test(message)
  ) {
    return `${section} probe timed out after ${PROBE_TIMEOUT_MS / 1000}s`
  }
  return `${section} probe failed: ${message || 'unknown error'}`
}

function probeOptions(environment: NodeJS.ProcessEnv, cwd: string): ProbeRunOptions {
  return {
    env: environment,
    cwd,
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BUFFER,
    shell: false
  }
}

function parsePythonOutput(
  stdout: string,
  requested: readonly string[],
  interpreter: string
): PythonProbeResult {
  const parsed: unknown = JSON.parse(stdout)
  if (!isRecord(parsed) || !isRecord(parsed.modules)) {
    throw new Error('unexpected Python probe output')
  }
  const foundModules = parsed.modules as Record<string, unknown>
  const modules = requested.map((name): ModuleProbeResult => {
    const item = foundModules[name]
    if (!isRecord(item)) return { name, found: false, version: null, unchecked: true }
    return {
      name,
      found: item.found === true,
      version: typeof item.version === 'string' ? item.version : null
    }
  })
  return {
    checked: true,
    interpreter,
    executable: typeof parsed.executable === 'string' ? parsed.executable : interpreter,
    version: typeof parsed.python === 'string' ? parsed.python : null,
    modules
  }
}

function parseROutput(
  stdout: string,
  requested: readonly string[],
  interpreter: string
): RProbeResult {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0)
  const header = lines[0]
  if (!header?.startsWith('R\t')) throw new Error('unexpected R probe output')
  const versions = new Map<string, { found: boolean; version: string | null }>()
  for (const line of lines.slice(1)) {
    const [name, flag, version] = line.split('\t')
    if (!name) continue
    versions.set(name, {
      found: flag === 'true' || flag === 'TRUE' || flag === '1',
      version: version ? version : null
    })
  }
  return {
    checked: true,
    interpreter,
    version: header.slice(2).trim() || null,
    packages: requested.map((name): RPackageProbeResult => {
      const item = versions.get(name)
      return item
        ? { name, found: item.found, version: item.version }
        : { name, found: false, version: null, unchecked: true }
    })
  }
}

export async function probePython(
  interpreter: string,
  modules: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  runner: ProbeRunner
): Promise<PythonProbeResult> {
  try {
    const result = await runner(
      interpreter,
      ['-c', PYTHON_PROBE_SCRIPT, ...modules],
      probeOptions(environment, cwd)
    )
    return parsePythonOutput(result.stdout, modules, interpreter)
  } catch (error) {
    return {
      checked: false,
      interpreter,
      executable: null,
      version: null,
      modules: modules.map((name) => ({ name, found: false, version: null, unchecked: true })),
      error: failureText('Python', error)
    }
  }
}

export async function probeR(
  interpreter: string,
  packages: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  runner: ProbeRunner
): Promise<RProbeResult> {
  try {
    const result = await runner(
      interpreter,
      ['--vanilla', '-e', R_PROBE_EXPRESSION, ...packages],
      probeOptions(environment, cwd)
    )
    return parseROutput(result.stdout, packages, interpreter)
  } catch (error) {
    return {
      checked: false,
      interpreter,
      version: null,
      packages: packages.map((name) => ({ name, found: false, version: null, unchecked: true })),
      error: failureText('R', error)
    }
  }
}

function pythonLines(python: PythonProbeResult): string[] {
  if (python.error) return [`python: ${python.error}; modules unchecked`]
  const version = python.version ?? 'version unknown'
  return [`python: ${version} at ${python.executable ?? python.interpreter}`]
}

function rLines(r: RProbeResult): string[] {
  if (r.error) return [`r: ${r.error}; packages unchecked`]
  return [`r: ${r.version ?? 'version unknown'}`]
}

function moduleLines(items: readonly (ModuleProbeResult | RPackageProbeResult)[]): string[] {
  return items.map((item) => {
    if (item.unchecked) return `${item.name}: unchecked`
    if (!item.found) return `${item.name}: not found`
    return `${item.name}: ${item.version ?? 'version unknown'}`
  })
}

export async function runCheckEnvironment(
  request: CheckEnvironmentRequest,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  runner: ProbeRunner
): Promise<CheckEnvironmentDetails> {
  const path = pathValue(environment)
  const commands = await Promise.all(
    request.commands.map(async (name) => ({ name, path: await resolveCommand(name, path) }))
  )
  let python: PythonProbeResult | undefined
  if (request.python_modules.length > 0) {
    const interpreter =
      (await resolveCommand('python3', path)) ?? (await resolveCommand('python', path))
    python = interpreter
      ? await probePython(interpreter, request.python_modules, environment, cwd, runner)
      : {
          checked: false,
          interpreter: null,
          executable: null,
          version: null,
          modules: request.python_modules.map((name) => ({
            name,
            found: false,
            version: null,
            unchecked: true
          })),
          error: 'no python3 or python found on PATH'
        }
  }
  let r: RProbeResult | undefined
  if (request.r_packages.length > 0) {
    const interpreter = await resolveCommand('Rscript', path)
    r = interpreter
      ? await probeR(interpreter, request.r_packages, environment, cwd, runner)
      : {
          checked: false,
          interpreter: null,
          version: null,
          packages: request.r_packages.map((name) => ({
            name,
            found: false,
            version: null,
            unchecked: true
          })),
          error: 'Rscript not found on PATH'
        }
  }
  return {
    commands,
    ...(python ? { python } : {}),
    ...(r ? { r } : {})
  }
}

export function formatResult(details: CheckEnvironmentDetails): string {
  const lines: string[] = []
  for (const command of details.commands) {
    lines.push(`${command.name}: ${command.path ?? 'not found'}`)
  }
  if (details.python) {
    lines.push(...pythonLines(details.python), ...moduleLines(details.python.modules))
  }
  if (details.r) {
    lines.push(...rLines(details.r), ...moduleLines(details.r.packages))
  }
  return lines.join('\n')
}
