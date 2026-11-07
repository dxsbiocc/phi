import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { launchLocalKernel } from '../../src/main/agent/engine/kernel-client'
import { KernelSessionFactory } from '../../src/main/agent/engine/kernel-session-factory'
import { SessionRoutingEngine } from '../../src/main/agent/engine/session-routing-engine'
import type {
  PhiEngine,
  PhiSessionCreateParams,
  RuntimeModel
} from '../../src/main/agent/engine/types'
import { agentConfig, MODEL_ID, PROVIDER_ID, startLoopbackProvider } from '../kernel-e2e/harness'
import { candidateContext, reserveEvidencePath, type CandidateContext } from '../kernel-candidate'
import {
  evaluateKernelPerfBudget,
  fourSessionWorkload,
  K0_LEGACY_WORKLOAD,
  percentileSummary,
  renderKernelPerfMarkdown,
  type KernelPerfReport
} from '../kernel-perf'
import { measureSameRunLegacyFourSession } from './legacy'
import { localProcessTree, PeakTreeSampler, type ProcessSample } from './process-tree'

interface PerfCliOptions {
  readonly target: 'local' | 'ssh'
  readonly host?: string
  readonly candidateId?: string
  readonly evidenceRoot?: string
  readonly buildDirectory?: string
  readonly baseline?: string
  readonly runtimeRoot?: string
  readonly readySamples: number
  readonly rounds: number
  readonly projectFiles: number
}

function unusedLegacyEngine(): PhiEngine {
  const unsupported = async (): Promise<never> => {
    throw new Error('Legacy execution was used by the kernel performance runner.')
  }
  const engine = {
    host: { register: () => () => undefined },
    sessions: { has: () => false },
    events: {
      onSessionEvent: () => () => undefined,
      onSessionState: () => () => undefined,
      onToolApproval: () => () => undefined
    },
    decisions: { models: async () => [], evaluate: unsupported },
    agentRuns: { list: async () => [] },
    shellJobs: { list: async () => [] },
    stop: async () => undefined
  }
  return engine as unknown as PhiEngine
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be positive.`)
  return parsed
}

function parseArgs(argv: readonly string[]): PerfCliOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`)
    if (
      ![
        '--target',
        '--host',
        '--candidate',
        '--evidence-root',
        '--build-dir',
        '--baseline',
        '--runtime-root',
        '--ready-samples',
        '--rounds',
        '--project-files'
      ].includes(key)
    ) {
      throw new Error(`Unknown argument: ${key}`)
    }
    values.set(key, value)
  }
  const target = values.get('--target') ?? 'local'
  if (target !== 'local' && target !== 'ssh') throw new Error('--target must be local or ssh.')
  const host = values.get('--host')
  if (target === 'ssh' && !host) throw new Error('--target ssh requires --host.')
  return {
    target,
    ...(host ? { host } : {}),
    ...(values.has('--candidate') ? { candidateId: values.get('--candidate') } : {}),
    ...(values.has('--evidence-root') ? { evidenceRoot: values.get('--evidence-root') } : {}),
    ...(values.has('--build-dir') ? { buildDirectory: resolve(values.get('--build-dir')!) } : {}),
    ...(values.has('--baseline') ? { baseline: resolve(values.get('--baseline')!) } : {}),
    ...(values.has('--runtime-root') ? { runtimeRoot: values.get('--runtime-root') } : {}),
    readySamples: parsePositiveInteger(values.get('--ready-samples') ?? '30', '--ready-samples'),
    rounds: parsePositiveInteger(values.get('--rounds') ?? '3', '--rounds'),
    projectFiles: parsePositiveInteger(values.get('--project-files') ?? '3000', '--project-files')
  }
}

function packageVersions(repoRoot: string): { phi: string; omp: string; native: string } {
  const version = (path: string): string =>
    (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
  return {
    phi: version(join(repoRoot, 'package.json')),
    omp: version(join(repoRoot, 'node_modules/@oh-my-pi/pi-coding-agent/package.json')),
    native: version(join(repoRoot, 'node_modules/@oh-my-pi/pi-natives/package.json'))
  }
}

function localTarget(): 'darwin-arm64' | 'linux-x64' | 'win32-x64' {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64'
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64'
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64'
  throw new Error(`Local kernel performance is unsupported on ${process.platform}/${process.arch}.`)
}

function prepareLargeProject(root: string, fileCount: number): string {
  const project = join(root, 'project')
  for (let index = 0; index < fileCount; index += 1) {
    const directory = join(project, `group-${Math.floor(index / 100)}`)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `file-${index}.txt`), `candidate fixture ${index}\n`)
  }
  const skill = join(project, '.phi', 'skills', 'candidate-perf', 'SKILL.md')
  mkdirSync(dirname(skill), { recursive: true })
  writeFileSync(skill, '# Candidate perf\n\nRead-only fixture skill for A20.\n')
  return project
}

function prepareLocalRuntime(
  root: string,
  provider: Awaited<ReturnType<typeof startLoopbackProvider>>,
  token: string
): { agentDir: string; home: string; temporary: string } {
  const agentDir = join(root, 'agent')
  const home = join(root, 'home')
  const temporary = join(root, 'tmp')
  for (const directory of [
    agentDir,
    home,
    temporary,
    join(home, '.config'),
    join(home, '.cache'),
    join(home, '.local', 'share')
  ]) {
    mkdirSync(directory, { recursive: true })
  }
  const config = agentConfig(provider.url, token)
  writeFileSync(join(agentDir, 'models.yml'), config.models)
  writeFileSync(join(agentDir, 'config.yml'), config.config)
  return { agentDir, home, temporary }
}

function localEnvironment(runtime: ReturnType<typeof prepareLocalRuntime>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: runtime.home,
    USERPROFILE: runtime.home,
    XDG_CONFIG_HOME: join(runtime.home, '.config'),
    XDG_CACHE_HOME: join(runtime.home, '.cache'),
    XDG_DATA_HOME: join(runtime.home, '.local', 'share'),
    TMPDIR: runtime.temporary,
    TMP: runtime.temporary,
    TEMP: runtime.temporary,
    OMP_APP_NAME: 'Phi',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    LANG: process.env.LANG ?? 'C.UTF-8'
  }
}

function model(): RuntimeModel {
  return { provider: PROVIDER_ID, id: MODEL_ID, name: 'A20 loopback', reasoning: false }
}

function resourceOptions(full: boolean): Record<string, boolean> {
  return {
    noExtensions: true,
    noSkills: !full,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true
  }
}

function createParams(input: {
  sessionId: string
  cwd: string
  agentDir: string
  full: boolean
  mcpSnapshot?: string
}): PhiSessionCreateParams {
  return {
    sessionId: input.sessionId,
    cwd: input.cwd,
    agentDir: input.agentDir,
    model: model(),
    sessionManager: { kind: 'memory', cwd: input.cwd },
    enableToolApproval: false,
    autoCompaction: { enabled: false },
    resourceOptions: resourceOptions(input.full),
    ...(input.mcpSnapshot
      ? {
          mcpServers: [
            {
              name: `candidate-${input.sessionId}`,
              config: {
                type: 'stdio',
                command: process.execPath,
                args: [resolve('tests/helpers/fixtureMcpServer.mjs'), input.mcpSnapshot, 'success'],
                cwd: input.cwd
              }
            }
          ]
        }
      : {})
  }
}

interface McpSnapshot {
  readonly pid: number
  readonly methods: readonly string[]
}

function verifyLocalMcpProcesses(
  snapshotPaths: readonly string[],
  processTree: readonly ProcessSample[]
): number {
  const snapshots = snapshotPaths.map(
    (path) => JSON.parse(readFileSync(path, 'utf8')) as McpSnapshot
  )
  const incomplete = snapshots.filter(
    (snapshot) =>
      !snapshot.methods.includes('initialize') || !snapshot.methods.includes('tools/list')
  )
  if (incomplete.length > 0) {
    throw new Error(`${incomplete.length} stdio MCP servers did not finish discovery.`)
  }
  const descendants = new Set(processTree.map((process) => process.pid))
  const missing = snapshots.map((snapshot) => snapshot.pid).filter((pid) => !descendants.has(pid))
  if (missing.length > 0) {
    throw new Error(
      `Stdio MCP PIDs were absent from the kernel process tree: ${missing.join(', ')}.`
    )
  }
  return snapshots.length
}

function configureFactory(factory: KernelSessionFactory): void {
  factory.registerHostHandler('settings.nextActionSuggestionsEnabled', () => false)
  factory.registerHostHandler('skills.scriptTools', () => ({ tools: [] }))
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function closeVerifiedLocalKernel(
  launched: Awaited<ReturnType<typeof launchLocalKernel>>
): Promise<void> {
  const pid = launched.process.pid
  await launched.close()
  if (pid && processAlive(pid)) throw new Error(`Local kernel cleanup left PID ${pid} alive.`)
}

async function measureReady(input: {
  samples: number
  buildDirectory: string
  target: ReturnType<typeof localTarget>
  versions: ReturnType<typeof packageVersions>
  runtime: ReturnType<typeof prepareLocalRuntime>
  project: string
}): Promise<NonNullable<KernelPerfReport['ready']>> {
  const kernel: number[] = []
  const session: number[] = []
  const once = async (record: boolean, index: number): Promise<void> => {
    let kernelReady = 0
    const factory = new KernelSessionFactory({
      launchLocal: async (_params, context) => {
        const started = performance.now()
        const launched = await launchLocalKernel({
          package: {
            directory: input.buildDirectory,
            target: input.target,
            phiVersion: input.versions.phi
          },
          agentDir: input.runtime.agentDir,
          home: input.runtime.home,
          cwd: input.project,
          env: localEnvironment(input.runtime),
          configureClient: context.configureClient,
          hello: { hostCapabilities: [...context.hostCapabilities] }
        })
        kernelReady = performance.now() - started
        return {
          client: launched.client,
          greeting: launched.greeting,
          close: async () => {
            await closeVerifiedLocalKernel(launched)
          }
        }
      }
    })
    configureFactory(factory)
    const engine = new SessionRoutingEngine(unusedLegacyEngine(), () => factory)
    const started = performance.now()
    try {
      await engine.sessions.create(
        createParams({
          sessionId: `ready-${record ? 'sample' : 'warmup'}-${index}`,
          cwd: input.project,
          agentDir: input.runtime.agentDir,
          full: false
        })
      )
      if (record) {
        kernel.push(kernelReady)
        session.push(performance.now() - started)
      }
    } finally {
      await engine.stop()
    }
  }
  await once(false, 0)
  for (let index = 0; index < input.samples; index += 1) await once(true, index)
  return {
    definition:
      'SessionRoutingEngine create start → compiled kernel hello; and → first memory session snapshot, after one unrecorded prewarm',
    warm: true,
    kernel: percentileSummary(kernel),
    firstSession: percentileSummary(session)
  }
}

async function measureWorkload(input: {
  sessions: 1 | 4
  rounds: number
  buildDirectory: string
  target: ReturnType<typeof localTarget>
  versions: ReturnType<typeof packageVersions>
  runtime: ReturnType<typeof prepareLocalRuntime>
  project: string
  provider: Awaited<ReturnType<typeof startLoopbackProvider>>
}): Promise<KernelPerfReport['workloads'][number]> {
  let sampler: PeakTreeSampler | undefined
  let kernelPid: number | undefined
  const factory = new KernelSessionFactory({
    launchLocal: async (_params, context) => {
      const launched = await launchLocalKernel({
        package: {
          directory: input.buildDirectory,
          target: input.target,
          phiVersion: input.versions.phi
        },
        agentDir: input.runtime.agentDir,
        home: input.runtime.home,
        cwd: input.project,
        env: localEnvironment(input.runtime),
        configureClient: context.configureClient,
        hello: { hostCapabilities: [...context.hostCapabilities] }
      })
      kernelPid = launched.process.pid
      if (!kernelPid) throw new Error('Compiled kernel did not expose its PID.')
      sampler = new PeakTreeSampler(() => localProcessTree(kernelPid!), kernelPid)
      sampler.start()
      return {
        client: launched.client,
        greeting: launched.greeting,
        close: async () => {
          await closeVerifiedLocalKernel(launched)
        }
      }
    }
  })
  configureFactory(factory)
  const engine = new SessionRoutingEngine(unusedLegacyEngine(), () => factory)
  const modelNetworkMs: number[] = []
  let idleReleasedRssMb: number | null = null
  let activeProcessTree: readonly ProcessSample[] = []
  let mcpSessionsVerified = 0
  try {
    for (let round = 0; round < input.rounds; round += 1) {
      const ids = Array.from(
        { length: input.sessions },
        (_, index) => `load-${input.sessions}-${round}-${index}`
      )
      await Promise.all(
        ids.map((sessionId) =>
          engine.sessions.create(
            createParams({
              sessionId,
              cwd: input.project,
              agentDir: input.runtime.agentDir,
              full: true,
              mcpSnapshot: join(input.runtime.temporary, `${sessionId}-mcp.json`)
            })
          )
        )
      )
      await sampler!.once()
      const roundProcessTree = [...sampler!.latest]
      const snapshotPaths = ids.map((sessionId) =>
        join(input.runtime.temporary, `${sessionId}-mcp.json`)
      )
      mcpSessionsVerified += verifyLocalMcpProcesses(snapshotPaths, roundProcessTree)
      if (roundProcessTree.length > activeProcessTree.length) activeProcessTree = roundProcessTree
      input.provider.enqueue(...ids.map((sessionId) => ({ text: `A20 ${sessionId} complete` })))
      await Promise.all(
        ids.map(async (sessionId) => {
          const started = performance.now()
          await engine.sessions.prompt({ sessionId, text: 'A20 loopback turn.' })
          modelNetworkMs.push(performance.now() - started)
        })
      )
      await sampler!.once()
      await Promise.all(ids.map((sessionId) => engine.sessions.dispose({ sessionId })))
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
    idleReleasedRssMb = await sampler!.once()
    const idleProcessTree = [...sampler!.latest]
    await sampler!.stop()
    return {
      sessions: input.sessions,
      rounds: input.rounds,
      peakRssMb: Math.round(sampler!.peakMb * 10) / 10,
      idleReleasedRssMb,
      modelNetworkMs: percentileSummary(modelNetworkMs),
      processTree: sampler!.peakTree,
      activeProcessTree,
      idleProcessTree,
      mcpSessionsVerified
    }
  } finally {
    await sampler?.stop().catch(() => undefined)
    await engine.stop().catch(() => undefined)
  }
}

function k0Baseline(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      memory?: Array<{ after?: Record<string, { totalMb?: number }> }>
    }
    const values = (parsed.memory ?? [])
      .map((entry) => entry.after?.['4']?.totalMb)
      .filter((value): value is number => typeof value === 'number')
    return values.length ? Math.max(...values) : null
  } catch {
    return null
  }
}

async function localReport(
  cli: PerfCliOptions,
  context: CandidateContext,
  versions: ReturnType<typeof packageVersions>,
  repoRoot: string
): Promise<KernelPerfReport> {
  const token = crypto.randomUUID().replaceAll('-', '')
  const provider = await startLoopbackProvider(token)
  const root = mkdtempSync(join(tmpdir(), 'phi-k4-perf-'))
  try {
    const runtime = prepareLocalRuntime(root, provider, token)
    const project = prepareLargeProject(root, cli.projectFiles)
    const target = localTarget()
    const buildDirectory =
      cli.buildDirectory ?? join(repoRoot, '.phi-build', 'kernel', versions.phi, target)
    const legacyBaseline = k0Baseline(
      cli.baseline ??
        resolve(repoRoot, '..', '..', 'Phi', '.phi-acceptance/k0-2/perf/result-659fcf9d.json')
    )
    const sameRunLegacy = await measureSameRunLegacyFourSession(cli.projectFiles, cli.rounds)
    const ready = await measureReady({
      samples: cli.readySamples,
      buildDirectory,
      target,
      versions,
      runtime,
      project
    })
    const workloads = [
      await measureWorkload({
        sessions: 1,
        rounds: cli.rounds,
        buildDirectory,
        target,
        versions,
        runtime,
        project,
        provider
      }),
      await measureWorkload({
        sessions: 4,
        rounds: cli.rounds,
        buildDirectory,
        target,
        versions,
        runtime,
        project,
        provider
      })
    ] as const
    const fourSessionPeak = workloads.find((item) => item.sessions === 4)?.peakRssMb ?? undefined
    return {
      schemaVersion: 1,
      candidateId: context.candidateId,
      target: 'local',
      measuredAt: new Date().toISOString(),
      machine: {
        os: `${platform()} ${process.getSystemVersion?.() ?? ''}`.trim(),
        arch: arch(),
        node: process.version,
        bun: (process.versions as Record<string, string | undefined>).bun ?? 'unknown'
      },
      versions,
      project: { files: cli.projectFiles, skills: true, stdioMcpPerSession: true },
      ready,
      workloads,
      legacy: {
        k0BaselineMb: legacyBaseline,
        k0Workload: K0_LEGACY_WORKLOAD,
        sameRunFourSessionMb: sameRunLegacy.peakRssMb,
        sameRunWorkload: fourSessionWorkload(cli.projectFiles, cli.rounds),
        sameRunFailure: sameRunLegacy.failure,
        sameRunProcessTree: sameRunLegacy.processTree,
        sameRunMcpSessionsVerified: sameRunLegacy.mcpSessionsVerified
      },
      budgets: evaluateKernelPerfBudget({
        localReadyP95Ms: ready.kernel.p95,
        ...(fourSessionPeak === undefined ? {} : { fourSessionPeakMb: fourSessionPeak }),
        ...(legacyBaseline === null ? {} : { legacyBaselineMb: legacyBaseline }),
        ...(sameRunLegacy.peakRssMb === null
          ? {}
          : { sameRunLegacyFourSessionMb: sameRunLegacy.peakRssMb })
      }),
      cleanup: { complete: true, remainingProcesses: [] }
    }
  } finally {
    await provider.close().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
}

function failureReport(
  cli: PerfCliOptions,
  context: CandidateContext,
  versions: ReturnType<typeof packageVersions>,
  error: unknown
): KernelPerfReport {
  const baseline = cli.baseline ? k0Baseline(cli.baseline) : null
  return {
    schemaVersion: 1,
    candidateId: context.candidateId,
    target: cli.target,
    ...(cli.host ? { host: cli.host } : {}),
    measuredAt: new Date().toISOString(),
    machine: {
      os: platform(),
      arch: arch(),
      node: process.version,
      bun: (process.versions as Record<string, string | undefined>).bun ?? 'unknown'
    },
    versions,
    project: { files: cli.projectFiles, skills: true, stdioMcpPerSession: true },
    ready: null,
    workloads: [],
    legacy: {
      k0BaselineMb: baseline,
      k0Workload: K0_LEGACY_WORKLOAD,
      sameRunFourSessionMb: null,
      sameRunWorkload: fourSessionWorkload(cli.projectFiles, cli.rounds),
      sameRunFailure: `Benchmark aborted before comparison: ${error instanceof Error ? error.message : String(error)}`,
      sameRunProcessTree: [],
      sameRunMcpSessionsVerified: 0
    },
    budgets: evaluateKernelPerfBudget({
      ...(baseline === null ? {} : { legacyBaselineMb: baseline })
    }),
    cleanup: { complete: false, remainingProcesses: [] },
    failure: error instanceof Error ? error.message : String(error)
  }
}

async function writeEvidence(
  context: CandidateContext,
  target: 'local' | 'ssh',
  report: KernelPerfReport
): Promise<{ json: string; markdown: string }> {
  const reserved = await reserveEvidencePath(context.directory, `perf-${target}`, 'json')
  const markdown = reserved.path.replace(/\.json$/u, '.md')
  await writeFile(
    reserved.path,
    `${JSON.stringify({ ...report, attempt: reserved.attempt }, null, 2)}\n`,
    {
      flag: 'w',
      mode: 0o600
    }
  )
  await writeFile(markdown, renderKernelPerfMarkdown(report), { flag: 'wx', mode: 0o600 })
  return { json: reserved.path, markdown }
}

export async function runKernelPerformanceCli(argv: readonly string[]): Promise<void> {
  const cli = parseArgs(argv)
  const repoRoot = resolve('.')
  const context = candidateContext({
    repoRoot,
    candidateId: cli.candidateId,
    evidenceRoot: cli.evidenceRoot
  })
  await readFile(join(context.directory, 'candidate.json'))
  const versions = packageVersions(repoRoot)
  let report: KernelPerfReport
  let failed = false
  try {
    report =
      cli.target === 'local'
        ? await localReport(cli, context, versions, repoRoot)
        : await (
            await import('./remote')
          ).runRemoteKernelPerformance({ cli, context, versions, repoRoot })
  } catch (error) {
    failed = true
    report = failureReport(cli, context, versions, error)
  }
  const evidence = await writeEvidence(context, cli.target, report)
  process.stdout.write(`${JSON.stringify({ ...report, evidence }, null, 2)}\n`)
  process.stdout.write(`${renderKernelPerfMarkdown(report)}\n`)
  if (failed || report.budgets.some((line) => line.status === 'FAIL')) process.exitCode = 1
}

export type { PerfCliOptions }
