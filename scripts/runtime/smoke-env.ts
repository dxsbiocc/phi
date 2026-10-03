// Builds one environment and runs import / command checks against it.
//
// Usage (needs the TS loader, so go through the npm script):
//   npm run runtime:smoke -- --spec resources/runtime/environments/phi-python \
//     --import python:numpy \
//     --run pdftoppm -v \
//     --run python -c "import numpy as np; print(np.__version__)"
//
// The runtime root is PHI_TEST_RUNTIME_ROOT when that variable is set, otherwise
// a fresh temporary directory. The prefix is left in place.

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  currentPlatform,
  ensureEnvironment,
  parseEnvironmentSpec,
  runInEnvironment,
  type EnsureProgressEvent,
  type EnvHandle,
  type EnvironmentSpec,
  type PhiPlatform
} from '../../src/main/agent/envs'

const CHECK_TIMEOUT_MS = 600_000
const DETAIL_LINES = 30
const PYTHON_MODULE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/
const FLAGS = new Set(['--spec', '--import', '--run'])

interface ImportCheck {
  kind: 'import'
  module: string
}

interface RunCheck {
  kind: 'run'
  argv: readonly string[]
}

type SmokeCheck = ImportCheck | RunCheck

interface SmokeCliOptions {
  specDir: string
  checks: readonly SmokeCheck[]
}

export function parseSmokeArgs(argv: readonly string[]): SmokeCliOptions {
  let specDir: string | undefined
  const checks: SmokeCheck[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--spec') {
      specDir = requireValue(argv, index, '--spec requires a directory')
      index += 1
      continue
    }
    if (arg === '--import') {
      const value = requireValue(argv, index, '--import requires python:<module>')
      index += 1
      checks.push(parseImport(value))
      continue
    }
    if (arg === '--run') {
      const taken = takeCommand(argv, index)
      if (taken.argv.length === 0) throw new Error('--run requires a command')
      checks.push({ kind: 'run', argv: taken.argv })
      index += taken.consumed
      continue
    }
    throw new Error(`unknown argument ${arg}`)
  }

  if (!specDir) {
    throw new Error(
      'usage: smoke-env.ts --spec <dir> [--import python:<module>]... [--run <cmd> ...]'
    )
  }
  if (checks.length === 0) {
    throw new Error('at least one --import or --run check is required')
  }
  return { specDir, checks }
}

function requireValue(argv: readonly string[], index: number, message: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(message)
  return value
}

function takeCommand(argv: readonly string[], index: number): { argv: string[]; consumed: number } {
  const command: string[] = []
  let consumed = 0
  while (index + 1 + consumed < argv.length) {
    const value = argv[index + 1 + consumed]
    if (!value || FLAGS.has(value)) break
    command.push(value)
    consumed += 1
  }
  return { argv: command, consumed }
}

function parseImport(value: string): ImportCheck {
  const prefix = 'python:'
  if (!value.startsWith(prefix)) {
    throw new Error(`--import must be python:<module>, got ${value}`)
  }
  const moduleName = value.slice(prefix.length)
  if (!PYTHON_MODULE.test(moduleName)) {
    throw new Error(`--import module is not a Python identifier: ${moduleName}`)
  }
  return { kind: 'import', module: moduleName }
}

function checkLabel(check: SmokeCheck): string {
  if (check.kind === 'import') return `import python:${check.module}`
  return `run ${check.argv.join(' ')}`
}

function checkArgv(check: SmokeCheck): string[] {
  if (check.kind === 'import') return ['python', '-c', `import ${check.module}`]
  return [...check.argv]
}

function runtimeRoot(): string {
  const configured = process.env.PHI_TEST_RUNTIME_ROOT
  if (configured && configured.trim().length > 0) {
    const root = resolve(configured)
    mkdirSync(root, { recursive: true })
    return root
  }
  return mkdtempSync(join(tmpdir(), 'phi-smoke-'))
}

function readSpecDirectory(specDir: string): {
  spec: EnvironmentSpec
  lockText: string
  platform: PhiPlatform
} {
  const directory = resolve(specDir)
  const specPath = join(directory, 'environment.yml')
  const text = readFile(specPath)
  const parsed = parseEnvironmentSpec(text)
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
  const platform = currentPlatform()
  const lockPath = join(directory, 'locks', `${platform}.txt`)
  return { spec: parsed.spec, lockText: readFile(lockPath), platform }
}

function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to read ${path}: ${message}`)
  }
}

function logProgress(event: EnsureProgressEvent): void {
  console.error(`${event.phase}: ${event.message}`)
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((entry) => entry.trim().length > 0)
  if (!line) return ''
  const trimmed = line.trim()
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed
}

function lastLines(text: string, limit: number): string[] {
  const lines = text.split(/\r?\n/)
  return lines.length > limit ? lines.slice(-limit) : lines
}

function printStream(name: string, text: string): void {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  console.log(`    ${name}:`)
  for (const line of lastLines(trimmed, DETAIL_LINES)) console.log(`    ${line}`)
}

async function runCheck(env: EnvHandle, check: SmokeCheck, cwd: string): Promise<boolean> {
  const label = checkLabel(check)
  const started = Date.now()
  try {
    const result = await runInEnvironment(env, checkArgv(check), {
      cwd,
      timeoutMs: CHECK_TIMEOUT_MS
    })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const ok = result.exitCode === 0 && result.terminated === undefined
    if (ok) {
      const evidence = firstLine(result.stdout) || firstLine(result.stderr)
      console.log(
        evidence ? `PASS ${label} (${seconds}s) ${evidence}` : `PASS ${label} (${seconds}s)`
      )
      return true
    }
    const why = result.terminated ?? `exit ${String(result.exitCode)}`
    console.log(`FAIL ${label} (${seconds}s) ${why}`)
    printStream('stdout', result.stdout)
    printStream('stderr', result.stderr)
    return false
  } catch (error) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const message = error instanceof Error ? error.message : String(error)
    console.log(`FAIL ${label} (${seconds}s) ${message}`)
    return false
  }
}

async function smokeEnvironment(options: SmokeCliOptions): Promise<number> {
  const { spec, lockText, platform } = readSpecDirectory(options.specDir)
  const root = runtimeRoot()
  const started = Date.now()
  const built = await ensureEnvironment({
    root,
    scope: 'phi',
    kind: 'base',
    spec,
    lockText,
    platform,
    onProgress: logProgress
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`spec ${resolve(options.specDir)}`)
  console.log(`platform ${platform}`)
  console.log(`env ${built.envId}`)
  console.log(`prefix ${built.prefix}`)
  console.log(`build ${built.created ? 'created' : 'reused'} in ${seconds}s`)
  if (built.hostMissing.length > 0) {
    console.log(`host missing ${built.hostMissing.join(', ')}`)
  }

  const cwd = tmpdir()
  let failed = 0
  for (const check of options.checks) {
    const passed = await runCheck(built, check, cwd)
    if (!passed) failed += 1
  }
  const passed = options.checks.length - failed
  console.log(`${String(passed)} passed, ${String(failed)} failed`)
  return failed
}

async function main(): Promise<void> {
  try {
    const options = parseSmokeArgs(process.argv.slice(2))
    const failed = await smokeEnvironment(options)
    if (failed > 0) process.exit(1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

const entry = process.argv[1]
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) {
  void main()
}
