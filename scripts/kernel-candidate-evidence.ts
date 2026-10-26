#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  reserveEvidencePath,
  writeKernelCandidate,
  type CandidateContext
} from './kernel-candidate'

export interface EvidenceStep {
  readonly name: string
  readonly command: readonly string[]
  readonly deadlineMs: number
  readonly environment?: Readonly<Record<string, string>>
  readonly skipIfMissing?: string
  readonly skipReason?: string
}

interface StepResult {
  readonly step: string
  readonly result: 'passed' | 'failed' | 'timeout' | 'environment-skip'
  readonly attempt: string
  readonly logPath: string
  readonly elapsedMs: number
  readonly detail?: string
}

export function candidateEvidenceSteps(input: {
  candidateId: string
  candidateDirectory: string
  phiVersion: string
}): EvidenceStep[] {
  const gate = ['node', '--import', './scripts/test-loader.mjs', '--test']
  return [
    { name: 'typecheck', command: ['bun', 'run', 'typecheck'], deadlineMs: 10 * 60_000 },
    {
      name: 'typecheck-tests',
      command: ['bun', 'run', 'typecheck:tests'],
      deadlineMs: 10 * 60_000
    },
    {
      name: 'lint',
      command: ['bunx', 'eslint', '--max-warnings', '1396', '.'],
      deadlineMs: 15 * 60_000
    },
    {
      name: 'engine-boundary',
      command: ['node', 'scripts/check-engine-boundary.mjs'],
      deadlineMs: 5 * 60_000
    },
    {
      name: 'main-boundary',
      command: ['bun', 'run', 'check:main-boundaries'],
      deadlineMs: 5 * 60_000
    },
    {
      name: 'architecture-boundary',
      command: ['bun', 'run', 'check:architecture'],
      deadlineMs: 5 * 60_000
    },
    { name: 'test-gate', command: ['node', 'scripts/test-gate.mjs'], deadlineMs: 45 * 60_000 },
    {
      name: 'build-kernel-darwin-arm64',
      command: ['bun', 'scripts/build-kernel.ts', '--target', 'darwin-arm64'],
      deadlineMs: 30 * 60_000
    },
    {
      name: 'build-kernel-linux-x64',
      command: ['bun', 'scripts/build-kernel.ts', '--target', 'linux-x64'],
      deadlineMs: 30 * 60_000
    },
    {
      name: 'a19-rollback-a17-tests',
      command: [
        ...gate,
        'tests/kernel-candidate-history.test.ts',
        'tests/kernel-candidate-rollback-drill.test.ts',
        'tests/kernel-local-package.test.ts',
        'tests/kernel-package-check.test.ts',
        'tests/kernel-remote-launcher.test.ts'
      ],
      deadlineMs: 15 * 60_000
    },
    {
      name: 'package-check',
      command: ['bun', 'scripts/check-kernel-package.ts', '--candidate', input.candidateId],
      deadlineMs: 10 * 60_000,
      skipIfMissing: resolve('dist/mac-arm64/Phi.app'),
      skipReason: 'dist/mac-arm64/Phi.app is not built on this environment'
    },
    {
      name: 'kernel-perf-local',
      command: [
        'bun',
        'scripts/kernel-perf.ts',
        '--target',
        'local',
        '--candidate',
        input.candidateId
      ],
      deadlineMs: 90 * 60_000
    }
  ]
}

function sshEvidenceSteps(input: {
  alias: string
  candidateId: string
  candidateDirectory: string
  attemptDirectory: string
  phiVersion: string
  runtimeRoot: string
}): EvidenceStep[] {
  const buildDirectory = resolve('.phi-build', 'kernel', input.phiVersion, 'linux-x64')
  const common = [
    'bun',
    'scripts/kernel-e2e.ts',
    '--target',
    'ssh',
    '--host',
    input.alias,
    '--runtime-root',
    input.runtimeRoot,
    '--build-dir',
    buildDirectory,
    '--deadline-min',
    '45'
  ]
  return [
    ...(['baseline', 'tools', 'plan', 'desktop-services', 'desktop-engine'] as const).map(
      (scenario): EvidenceStep => ({
        name: `ssh-${scenario}`,
        command: [
          ...common,
          '--scenario',
          scenario,
          '--out',
          join(input.attemptDirectory, `ssh-${scenario}.json`)
        ],
        environment: { PHI_KERNEL_ENGINE: 'both' },
        deadlineMs: 50 * 60_000
      })
    ),
    {
      name: 'kernel-perf-ssh',
      command: [
        'bun',
        'scripts/kernel-perf.ts',
        '--target',
        'ssh',
        '--host',
        input.alias,
        '--runtime-root',
        input.runtimeRoot,
        '--candidate',
        input.candidateId
      ],
      environment: { PHI_KERNEL_ENGINE: 'both' },
      deadlineMs: 120 * 60_000
    }
  ]
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  const signal = (value: NodeJS.Signals): void => {
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid!, value)
        return
      } catch {
        // Fall back to the direct child if the process group already changed.
      }
    }
    child.kill(value)
  }
  signal('SIGTERM')
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
  if (child.exitCode === null && child.signalCode === null) signal('SIGKILL')
}

async function runStep(
  step: EvidenceStep,
  repoRoot: string,
  logPath: string,
  attemptLabel: string
): Promise<StepResult> {
  const started = Date.now()
  await mkdir(dirname(logPath), { recursive: true })
  if (step.skipIfMissing && !existsSync(step.skipIfMissing)) {
    await writeFile(
      logPath,
      `ENVIRONMENT SKIP: ${step.skipReason}\nCOMMAND: ${step.command.join(' ')}\n`,
      { flag: 'wx', mode: 0o600 }
    )
    return {
      step: step.name,
      result: 'environment-skip',
      attempt: attemptLabel,
      logPath,
      elapsedMs: Date.now() - started,
      detail: step.skipReason
    }
  }
  const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 })
  log.write(`COMMAND: ${step.command.join(' ')}\nDEADLINE_MS: ${step.deadlineMs}\n\n`)
  const child = spawn(step.command[0], step.command.slice(1), {
    cwd: repoRoot,
    env: { ...process.env, ...step.environment },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.pipe(log, { end: false })
  child.stderr?.pipe(log, { end: false })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void terminateProcessTree(child)
  }, step.deadlineMs)
  const outcome = await new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    error?: Error
  }>((resolveOutcome) => {
    child.once('error', (error) => resolveOutcome({ code: null, signal: null, error }))
    child.once('close', (code, signal) => resolveOutcome({ code, signal }))
  })
  clearTimeout(timer)
  if (timedOut) await terminateProcessTree(child)
  log.end(
    `\nRESULT: ${timedOut ? 'timeout' : outcome.code === 0 ? 'passed' : 'failed'} code=${String(outcome.code)} signal=${String(outcome.signal)}\n`
  )
  await new Promise<void>((resolveLog) => log.once('close', resolveLog))
  const result = timedOut ? 'timeout' : outcome.code === 0 ? 'passed' : 'failed'
  return {
    step: step.name,
    result,
    attempt: attemptLabel,
    logPath,
    elapsedMs: Date.now() - started,
    ...(outcome.error ? { detail: outcome.error.message } : {})
  }
}

function summaryTable(results: readonly StepResult[]): string {
  return [
    '| Step | Result | Attempt | Log | Environment skip |',
    '| --- | --- | --- | --- | --- |',
    ...results.map(
      (result) =>
        `| ${result.step} | ${result.result} | ${result.attempt} | ${result.logPath} | ${result.result === 'environment-skip' ? (result.detail ?? 'yes') : ''} |`
    )
  ].join('\n')
}

function parseArgs(argv: readonly string[]): {
  candidateId?: string
  evidenceRoot?: string
  withSsh?: string
  runtimeRoot?: string
  allowedUntrackedDocs: string[]
} {
  const result: {
    candidateId?: string
    evidenceRoot?: string
    withSsh?: string
    runtimeRoot?: string
    allowedUntrackedDocs: string[]
  } = { allowedUntrackedDocs: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`)
    if (key === '--candidate') result.candidateId = value
    else if (key === '--evidence-root') result.evidenceRoot = value
    else if (key === '--with-ssh') result.withSsh = value
    else if (key === '--runtime-root') result.runtimeRoot = value
    else if (key === '--allow-untracked-doc') result.allowedUntrackedDocs.push(value)
    else throw new Error(`Unknown argument: ${key}`)
  }
  return result
}

function leadCommands(input: {
  candidateId: string
  phiVersion: string
  runtimeRoot: string
}): string[] {
  const alias = '<ssh-alias>'
  const build = `.phi-build/kernel/${input.phiVersion}/linux-x64`
  return [
    ...(['baseline', 'tools', 'plan', 'desktop-services', 'desktop-engine'] as const).map(
      (scenario) =>
        `PHI_KERNEL_ENGINE=both bun scripts/kernel-e2e.ts --target ssh --host ${alias} --runtime-root ${input.runtimeRoot} --build-dir ${build} --scenario ${scenario} --deadline-min 45 < /dev/null`
    ),
    `PHI_KERNEL_ENGINE=both bun scripts/kernel-perf.ts --target ssh --host ${alias} --runtime-root ${input.runtimeRoot} --candidate ${input.candidateId} < /dev/null`,
    `bun run build:mac < /dev/null && bun scripts/check-kernel-package.ts --candidate ${input.candidateId} < /dev/null`
  ]
}

async function refreshCandidate(
  cli: ReturnType<typeof parseArgs>,
  context: CandidateContext
): Promise<void> {
  await writeKernelCandidate({
    candidateId: context.candidateId,
    evidenceRoot: cli.evidenceRoot,
    allowedUntrackedDocs: cli.allowedUntrackedDocs
  })
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2))
  const repoRoot = resolve('.')
  const candidate = await writeKernelCandidate({
    repoRoot,
    candidateId: cli.candidateId,
    evidenceRoot: cli.evidenceRoot,
    allowedUntrackedDocs: cli.allowedUntrackedDocs
  })
  const context = candidate.context
  const phiVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
    .version
  const reserved = await reserveEvidencePath(context.directory, 'candidate-evidence', 'json')
  const attemptLabel = reserved.attempt === 1 ? 'first-attempt' : `retry-${reserved.attempt - 1}`
  const attemptDirectory = reserved.path.replace(/\.json$/u, '')
  await mkdir(attemptDirectory, { recursive: false })
  const runtimeRoot = cli.runtimeRoot ?? `/tmp/phi-k4-2-${context.candidateId}`
  const steps = candidateEvidenceSteps({
    candidateId: context.candidateId,
    candidateDirectory: context.directory,
    phiVersion
  })
  if (cli.withSsh) {
    steps.push(
      ...sshEvidenceSteps({
        alias: cli.withSsh,
        candidateId: context.candidateId,
        candidateDirectory: context.directory,
        attemptDirectory,
        phiVersion,
        runtimeRoot
      })
    )
  }
  const results: StepResult[] = []
  for (const step of steps) {
    const result = await runStep(
      step,
      repoRoot,
      join(attemptDirectory, `${step.name}.log`),
      attemptLabel
    )
    results.push(result)
    if (step.name === 'build-kernel-linux-x64') await refreshCandidate(cli, context)
  }
  const commands = cli.withSsh
    ? []
    : leadCommands({ candidateId: context.candidateId, phiVersion, runtimeRoot })
  const summary = {
    schemaVersion: 1,
    candidateId: context.candidateId,
    attempt: reserved.attempt,
    attemptLabel,
    completedAt: new Date().toISOString(),
    ok: results.every(
      (result) => result.result === 'passed' || result.result === 'environment-skip'
    ),
    complete: results.every((result) => result.result === 'passed') && commands.length === 0,
    results,
    leadOnlyCommands: commands
  }
  await writeFile(reserved.path, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  const markdownPath = reserved.path.replace(/\.json$/u, '.md')
  const markdown = `# Candidate evidence ${attemptLabel}\n\n${summaryTable(results)}\n\n${
    commands.length
      ? `## Lead-only commands\n\n${commands.map((command) => `- \`${command}\``).join('\n')}`
      : 'SSH steps executed in this attempt.'
  }\n`
  await writeFile(markdownPath, markdown, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`${summaryTable(results)}\n`)
  if (commands.length) {
    process.stdout.write(
      `\nLead-only commands:\n${commands.map((command) => `${command}\n`).join('')}`
    )
  }
  process.stdout.write(`\nSummary: ${reserved.path}\n`)
  if (results.some((result) => result.result === 'failed' || result.result === 'timeout')) {
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
