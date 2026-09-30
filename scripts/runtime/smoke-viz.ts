// Builds the viz environment and renders every omics-visualization template
// that ships a plot.R plus an example input.
//
// Usage (needs the TS loader, so go through the npm script):
//   npm run runtime:smoke:viz
//   npm run runtime:smoke:viz -- --spec resources/plugins/visualization/environments/viz \
//     --templates resources/plugins/visualization/skills/omics-visualization/scripts
//
// The runtime root is PHI_TEST_RUNTIME_ROOT when that variable is set, otherwise
// a fresh temporary directory. The prefix is left in place.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  currentPlatform,
  ensureEnvironment,
  parseEnvironmentSpec,
  parseLockDownloadBytes,
  runInEnvironment,
  type EnsureProgressEvent,
  type EnvHandle,
  type EnvironmentSpec,
  type PhiPlatform
} from '../../src/main/agent/envs'

const RENDER_TIMEOUT_MS = 180_000
const QA_TIMEOUT_MS = 60_000
const STDERR_TAIL = 15
const NA_INPUT = 'NA'

interface ExampleRun {
  /** Tokens after `Rscript plot.R`, including the output file name. */
  tokens: readonly string[]
}

interface PlotJob {
  kind: 'plot'
  label: string
  directory: string
  script: string
  examples: readonly ExampleRun[]
}

interface ValidateJob {
  kind: 'validate'
  label: string
  script: string
}

type TemplateJob = PlotJob | ValidateJob

interface SmokeVizOptions {
  specDir: string
  templatesDir: string
}

interface CommandFailure {
  detail: string
  stderr: string
  stdout: string
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..')
}

export function parseSmokeVizArgs(argv: readonly string[]): SmokeVizOptions {
  const root = repoRoot()
  let specDir = join(root, 'resources/plugins/visualization/environments/viz')
  let templatesDir = join(
    root,
    'resources/plugins/visualization/skills/omics-visualization/scripts'
  )

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--spec') {
      specDir = requireValue(argv, index, '--spec requires a directory')
      index += 1
      continue
    }
    if (arg === '--templates') {
      templatesDir = requireValue(argv, index, '--templates requires a directory')
      index += 1
      continue
    }
    throw new Error(`unknown argument ${arg ?? ''}`)
  }

  return { specDir: resolve(specDir), templatesDir: resolve(templatesDir) }
}

function requireValue(argv: readonly string[], index: number, message: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(message)
  return value
}

function runtimeRoot(): string {
  const configured = process.env.PHI_TEST_RUNTIME_ROOT
  if (configured && configured.trim().length > 0) {
    const root = resolve(configured)
    mkdirSync(root, { recursive: true })
    return root
  }
  return mkdtempSync(join(tmpdir(), 'phi-smoke-viz-'))
}

function readSpecDirectory(specDir: string): {
  spec: EnvironmentSpec
  lockText: string
  platform: PhiPlatform
} {
  const specPath = join(specDir, 'environment.yml')
  const parsed = parseEnvironmentSpec(readText(specPath))
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
  const platform = currentPlatform()
  const lockPath = join(specDir, 'locks', `${platform}.txt`)
  return { spec: parsed.spec, lockText: readText(lockPath), platform }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to read ${path}: ${message}`)
  }
}

function logProgress(event: EnsureProgressEvent): void {
  const line = event.message
    .trim()
    .split(/\r?\n/)
    .find((entry) => entry.trim().length > 0)
  console.error(`${event.phase}: ${line ?? event.message}`)
}

function headerOf(source: string): string {
  const lines: string[] = []
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      lines.push(line)
      continue
    }
    break
  }
  return lines.join('\n')
}

function parsePlotExamples(source: string): ExampleRun[] {
  const examples: ExampleRun[] = []
  for (const line of headerOf(source).split(/\r?\n/)) {
    const match = /^#\s+Rscript\s+plot\.R\s+(.+?)\s*$/.exec(line)
    if (!match?.[1]) continue
    const tokens = match[1].split(/\s+/).filter((token) => token.length > 0)
    if (tokens.length < 2) continue
    examples.push({ tokens })
  }
  return examples
}

function isStandaloneValidate(source: string): boolean {
  return /^#\s*Usage:\s*Rscript\s+validate_layouts\.R\b/m.test(headerOf(source))
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/')
}

export function collectTemplateJobs(templatesDir: string): TemplateJob[] {
  const jobs: TemplateJob[] = []

  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      walk(join(dir, entry.name))
    }

    const plot = join(dir, 'plot.R')
    if (existsSync(plot)) {
      const examples = parsePlotExamples(readText(plot))
      if (examples.length > 0) {
        jobs.push({
          kind: 'plot',
          label: posixRelative(templatesDir, dir),
          directory: dir,
          script: plot,
          examples
        })
      }
    }

    const validate = join(dir, 'validate_layouts.R')
    if (existsSync(validate)) {
      const source = readText(validate)
      if (isStandaloneValidate(source)) {
        jobs.push({
          kind: 'validate',
          label: posixRelative(templatesDir, validate).replace(/\.R$/, ''),
          script: validate
        })
      }
    }
  }

  walk(templatesDir)
  jobs.sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0))
  return jobs
}

function tailLines(text: string, limit: number): string[] {
  const lines = text.split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length > limit ? lines.slice(-limit) : lines
}

function printTail(text: string): void {
  const lines = tailLines(text.trim(), STDERR_TAIL)
  if (lines.length === 0) return
  for (const line of lines) console.log(`    ${line}`)
}

function exampleInputs(example: ExampleRun, directory: string): string[] {
  const inputs = example.tokens.slice(0, -1)
  return inputs.map((token) => {
    if (token === NA_INPUT) return token
    return resolve(directory, token)
  })
}

function missingInputs(example: ExampleRun, directory: string): string[] {
  const missing: string[] = []
  for (const token of example.tokens.slice(0, -1)) {
    if (token === NA_INPUT) continue
    const path = resolve(directory, token)
    if (!existsSync(path)) missing.push(token)
  }
  return missing
}

async function runCommand(
  env: EnvHandle,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number
): Promise<CommandFailure | undefined> {
  try {
    const result = await runInEnvironment(env, argv, { cwd, timeoutMs })
    if (result.exitCode === 0 && result.terminated === undefined) return undefined
    const why = result.terminated ?? `exit ${String(result.exitCode)}`
    return { detail: why, stderr: result.stderr, stdout: result.stdout }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { detail: message, stderr: '', stdout: '' }
  }
}

function printFailure(failure: CommandFailure): void {
  console.log(`    ${failure.detail}`)
  if (failure.stderr.trim().length > 0) printTail(failure.stderr)
  else printTail(failure.stdout)
}

async function renderPlot(env: EnvHandle, job: PlotJob, qaScript: string): Promise<boolean> {
  const failures: { command: string; failure: CommandFailure }[] = []
  for (const example of job.examples) {
    const outputName = example.tokens[example.tokens.length - 1] ?? 'output.pdf'
    const command = `Rscript plot.R ${example.tokens.join(' ')}`
    const missing = missingInputs(example, job.directory)
    if (missing.length > 0) {
      failures.push({
        command,
        failure: {
          detail: `missing example input: ${missing.join(', ')}`,
          stderr: '',
          stdout: ''
        }
      })
      continue
    }

    const work = mkdtempSync(join(tmpdir(), 'phi-viz-plot-'))
    const output = join(work, outputName)
    try {
      const rendered = await runCommand(
        env,
        ['Rscript', job.script, ...exampleInputs(example, job.directory), output],
        work,
        RENDER_TIMEOUT_MS
      )
      if (rendered) {
        failures.push({ command, failure: rendered })
        continue
      }
      const qa = await runCommand(env, ['python', qaScript, output], work, QA_TIMEOUT_MS)
      if (qa) failures.push({ command: `qa ${outputName}`, failure: qa })
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  if (failures.length === 0) {
    console.log(`ok ${job.label}`)
    return true
  }
  console.log(`FAIL ${job.label}`)
  for (const item of failures) {
    console.log(`    ${item.command}`)
    printFailure(item.failure)
  }
  return false
}

async function runValidate(env: EnvHandle, job: ValidateJob): Promise<boolean> {
  const work = mkdtempSync(join(tmpdir(), 'phi-viz-validate-'))
  try {
    const failed = await runCommand(env, ['Rscript', job.script], work, QA_TIMEOUT_MS)
    if (!failed) {
      console.log(`ok ${job.label}`)
      return true
    }
    console.log(`FAIL ${job.label}`)
    console.log('    Rscript validate_layouts.R')
    printFailure(failed)
    return false
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function smokeViz(options: SmokeVizOptions): Promise<number> {
  const { spec, lockText, platform } = readSpecDirectory(options.specDir)
  const jobs = collectTemplateJobs(options.templatesDir)
  if (jobs.length === 0) throw new Error(`no templates under ${options.templatesDir}`)
  const qaScript = join(options.templatesDir, 'qa_single_plot.py')
  if (!existsSync(qaScript)) throw new Error(`qa script not found: ${qaScript}`)

  const root = runtimeRoot()
  const buildStarted = Date.now()
  const built = await ensureEnvironment({
    root,
    scope: 'plugin',
    owner: 'visualization',
    kind: 'package',
    spec,
    lockText,
    platform,
    onProgress: logProgress
  })
  const buildSeconds = ((Date.now() - buildStarted) / 1000).toFixed(1)
  const downloadBytes = parseLockDownloadBytes(lockText)
  console.error(`platform ${platform}`)
  console.error(`env ${built.envId}`)
  console.error(`prefix ${built.prefix}`)
  console.error(`build ${built.created ? 'created' : 'reused'} in ${buildSeconds}s`)
  if (downloadBytes !== undefined) console.error(`download-bytes ${String(downloadBytes)}`)

  const renderStarted = Date.now()
  let failed = 0
  for (const job of jobs) {
    const passed =
      job.kind === 'plot' ? await renderPlot(built, job, qaScript) : await runValidate(built, job)
    if (!passed) failed += 1
  }
  const renderSeconds = ((Date.now() - renderStarted) / 1000).toFixed(1)
  const passed = jobs.length - failed
  console.log(`${String(passed)} ok, ${String(failed)} failed`)
  console.log(`build ${buildSeconds}s`)
  console.log(`render ${renderSeconds}s`)
  console.log(`prefix ${built.prefix}`)
  return failed
}

async function main(): Promise<void> {
  try {
    const failed = await smokeViz(parseSmokeVizArgs(process.argv.slice(2)))
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
