#!/usr/bin/env bun

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'

import { launchLocalKernel, type LocalKernelLauncher } from '../src/main/agent/engine/kernel-client'
import {
  launchRemoteKernel,
  probeRemoteKernelHostProfile,
  type LaunchedRemoteKernel
} from '../src/main/agent/engine/kernel-client/remote'
import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteReverseTunnel,
  type RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import type { RemoteUploadPhaseTiming } from '../src/main/agent/transfer/remote-upload-types'
import {
  parseKernelE2eArgs,
  type KernelE2eCliOptions,
  type KernelE2eScenario,
  type KernelE2eTarget
} from './kernel-e2e/options'
import { prepareKernelE2eRemoteHelper } from './kernel-e2e/prepare-remote-helper'
import {
  configureInitialModelProxy,
  configureModelProxy,
  runSshModelProxyReconnectScenario
} from './kernel-e2e/model-proxy-scenario'
import { effectiveDeadlineMinutes, readDeployBudget } from './kernel-e2e/deploy-budget'
import {
  eventually,
  extractKernelPid,
  KERNEL_E2E_HOST_CAPABILITIES,
  runSshLifecycleScenario,
  shellLiteral,
  toolEvidence
} from './kernel-e2e/lifecycle-scenarios'
import { runToolsScenario, type ToolsReadEvidence } from './kernel-e2e/tools-scenario'
import { runPlanScenario } from './kernel-e2e/plan-scenario'
import { shutdownSshScenarioKernel } from './kernel-e2e/ssh-kernel-cleanup'
import {
  agentConfig,
  bounded,
  boundedByDeadline,
  errorMessage,
  record,
  ScenarioClient,
  startLoopbackProvider
} from './kernel-e2e/harness'

interface StepResult {
  name: string
  passed: boolean
  reason?: string
  elapsedMs: number
}

interface E2eReport {
  schemaVersion: 1
  ok: boolean
  target: KernelE2eTarget
  scenario: KernelE2eScenario
  host?: string
  hostProfile: {
    os: string
    arch: string
    libc?: string
    glibcVersion?: string
    variant?: string
  }
  versions: {
    phi: string
    kernel: string
    omp: string
  }
  deploy: {
    outcome: 'local' | 'fresh' | 'reused'
    remoteCommandCount: number
    reattachRemoteCommandCount?: number
    executablePath: string
    nativePath?: string
    transferTimings: RemoteUploadPhaseTiming[]
  }
  limits: {
    deadlineMinutes: number
    deployTimeoutMs?: number
    deployUploadBytes?: number
  }
  timingsMs: {
    ready: number
    firstSessionCreate: number
    turns: Record<string, number>
    abortToExit?: number
  }
  memoryKb: {
    afterOneSession: number | null
    afterTwoSessions: number | null
  }
  evidence: ToolsReadEvidence & {
    kernelPidA?: number
    kernelPidB?: number
    longChildPid?: number
    reconnectedKernelPid?: number
    initialModelProxyPort?: number
    reconnectedModelProxyPort?: number
    modelProxyRequestAttempts?: number
    modelProxyCompletedRequests?: number
    approvalCount: number
    approvalObservedBeforeWrite: boolean
    bearerToken: 'random-test-only-not-recorded'
    planRunId?: string
    planReviewCount?: number
    agentRunState?: string
    planApprovalTools?: string[]
  }
  steps: StepResult[]
  cleanup: {
    temporaryProjectsRemoved: boolean
    deployedKernelRemovalCommand?: string
  }
  failure?: string
}

interface ScenarioPaths {
  root: string
  agentDir: string
  home: string
  projectA: string
  projectB: string
  writtenFile: string
  childPidFile: string
}

interface TargetFiles {
  readonly paths: ScenarioPaths
  projectPath(relativePath: string): string
  homePath(relativePath: string): string
  prepare(): Promise<void>
  writeAgentConfig(baseUrl: string, token: string): Promise<void>
  write(path: string, content: Uint8Array | string): Promise<void>
  read(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  processAlive(pid: number): Promise<boolean>
  sampleRss(pid: number): Promise<number | null>
  cleanup(): Promise<void>
}

const packageVersion = (
  JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    version: string
  }
).version

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000
}

function scenarioPaths(root: string, remote = false): ScenarioPaths {
  const pathApi = remote ? posix : { join }
  const projectA = pathApi.join(root, 'project-a')
  return {
    root,
    agentDir: pathApi.join(root, 'agent'),
    home: pathApi.join(root, 'home'),
    projectA,
    projectB: pathApi.join(root, 'project-b'),
    writtenFile: pathApi.join(projectA, 'approved.txt'),
    childPidFile: pathApi.join(projectA, 'long-child.pid')
  }
}

function localFiles(runtimeRoot: string): TargetFiles {
  const paths = scenarioPaths(join(runtimeRoot, 'kernel-e2e', randomUUID()))
  return {
    paths,
    projectPath: (relativePath) => join(paths.projectA, relativePath),
    homePath: (relativePath) => join(paths.home, relativePath),
    async prepare() {
      for (const directory of [
        paths.agentDir,
        paths.home,
        join(paths.home, '.config'),
        join(paths.home, '.cache'),
        join(paths.home, '.local', 'share'),
        join(paths.root, 'tmp'),
        paths.projectA,
        paths.projectB
      ]) {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
      }
      writeFileSync(join(paths.projectA, 'shared.txt'), 'ONLY_SESSION_A\n')
      writeFileSync(join(paths.projectB, 'shared.txt'), 'ONLY_SESSION_B\n')
    },
    async writeAgentConfig(baseUrl, token) {
      const config = agentConfig(baseUrl, token)
      writeFileSync(join(paths.agentDir, 'models.yml'), config.models)
      writeFileSync(join(paths.agentDir, 'config.yml'), config.config)
    },
    async write(path, content) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(path, content)
    },
    async read(path) {
      return readFileSync(path, 'utf8')
    },
    async exists(path) {
      return existsSync(path)
    },
    async processAlive(pid) {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    async sampleRss(pid) {
      const result = spawnSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
      const rss = Number(result.stdout.trim())
      return Number.isFinite(rss) && rss > 0 ? rss : null
    },
    async cleanup() {
      rmSync(paths.root, { recursive: true, force: true })
    }
  }
}

function remoteFiles(session: RemoteSshSession, runtimeRoot: string): TargetFiles {
  const paths = scenarioPaths(posix.join(runtimeRoot, 'kernel-e2e', randomUUID()), true)
  let stagingRoot: string | undefined
  const run = async (command: string): Promise<string> => {
    const result = await session.exec(command)
    if (result.code !== 0 || result.signal)
      throw new Error(result.stderr || 'remote command failed')
    return result.stdout
  }
  return {
    paths,
    projectPath: (relativePath) => posix.join(paths.projectA, relativePath),
    homePath: (relativePath) => posix.join(paths.home, relativePath),
    async prepare() {
      await run(
        `umask 077; mkdir -p -- ${[paths.agentDir, paths.home, paths.projectA, paths.projectB]
          .map(shellQuote)
          .join(' ')}; chmod 700 -- ${[
          paths.root,
          paths.agentDir,
          paths.home,
          paths.projectA,
          paths.projectB
        ]
          .map(shellQuote)
          .join(' ')}`
      )
      await session.writeTextFile(posix.join(paths.projectA, 'shared.txt'), 'ONLY_SESSION_A\n')
      await session.writeTextFile(posix.join(paths.projectB, 'shared.txt'), 'ONLY_SESSION_B\n')
    },
    async writeAgentConfig(baseUrl, token) {
      const config = agentConfig(baseUrl, token)
      await session.writeTextFile(posix.join(paths.agentDir, 'models.yml'), config.models)
      await session.writeTextFile(posix.join(paths.agentDir, 'config.yml'), config.config)
    },
    async write(path, content) {
      await session.mkdirp(posix.dirname(path))
      stagingRoot ??= mkdtempSync(join(tmpdir(), 'phi-kernel-e2e-tools-'))
      const staged = join(stagingRoot, randomUUID())
      writeFileSync(staged, content)
      await session.uploadFile(staged, path, { remoteRoot: paths.root })
    },
    read: (path) => session.readTextFile(path),
    async exists(path) {
      return (await session.exec(`test -e ${shellQuote(path)}`)).code === 0
    },
    async processAlive(pid) {
      return (await session.exec(`kill -0 ${pid} 2>/dev/null`)).code === 0
    },
    async sampleRss(pid) {
      const stdout = await run(`ps -o rss= -p ${pid}`)
      const rss = Number(stdout.trim())
      return Number.isFinite(rss) && rss > 0 ? rss : null
    },
    async cleanup() {
      try {
        await run(`rm -rf -- ${shellQuote(paths.root)}`)
      } finally {
        if (stagingRoot) rmSync(stagingRoot, { recursive: true, force: true })
      }
    }
  }
}

async function runScenario(options: KernelE2eCliOptions): Promise<E2eReport> {
  // A fresh SSH deployment uploads ~260 MB; size its budget for a 0.2 MB/s link.
  const deployBudget =
    options.target === 'ssh' ? readDeployBudget(options.buildDirectory) : undefined
  const deadlineMinutes = deployBudget
    ? effectiveDeadlineMinutes(options.deadlineMinutes, deployBudget.deployTimeoutMs)
    : options.deadlineMinutes
  const report: E2eReport = {
    schemaVersion: 1,
    ok: false,
    target: options.target,
    scenario: options.scenario,
    ...(options.host ? { host: options.host } : {}),
    hostProfile: { os: process.platform, arch: process.arch },
    versions: { phi: packageVersion, kernel: 'unknown', omp: 'unknown' },
    deploy: {
      outcome: options.target === 'local' ? 'local' : 'fresh',
      remoteCommandCount: 0,
      executablePath: '',
      transferTimings: []
    },
    limits: {
      deadlineMinutes,
      ...(deployBudget
        ? {
            deployTimeoutMs: deployBudget.deployTimeoutMs,
            deployUploadBytes: deployBudget.uploadBytes
          }
        : {})
    },
    timingsMs: { ready: 0, firstSessionCreate: 0, turns: {} },
    memoryKb: { afterOneSession: null, afterTwoSessions: null },
    evidence: {
      approvalCount: 0,
      approvalObservedBeforeWrite: false,
      bearerToken: 'random-test-only-not-recorded'
    },
    steps: [],
    cleanup: { temporaryProjectsRemoved: false }
  }
  const overallDeadlineAt = Date.now() + deadlineMinutes * 60_000
  const stepTimeoutMs = (name: string): number => {
    if (name === 'remote kernel deployed and launched')
      return deployBudget?.deployTimeoutMs ?? 12 * 60_000
    if (name === 'marker-backed remote helper prepared') return 5 * 60_000
    return 5 * 60_000
  }
  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const started = process.hrtime.bigint()
    try {
      const value = await boundedByDeadline(
        Promise.resolve().then(action),
        name,
        stepTimeoutMs(name),
        overallDeadlineAt
      )
      report.steps.push({ name, passed: true, elapsedMs: elapsedMs(started) })
      return value
    } catch (error) {
      report.steps.push({
        name,
        passed: false,
        reason: errorMessage(error),
        elapsedMs: elapsedMs(started)
      })
      throw error
    }
  }

  const token = randomBytes(32).toString('base64url')
  let provider: Awaited<ReturnType<typeof startLoopbackProvider>> | undefined
  let ssh: RemoteSshSession | undefined
  let tunnel: RemoteReverseTunnel | undefined
  let files: TargetFiles | undefined
  let localLaunch: LocalKernelLauncher | undefined
  let remoteLaunch: LaunchedRemoteKernel | undefined
  let scenario: ScenarioClient | undefined
  let remoteProfile: Awaited<ReturnType<typeof probeRemoteKernelHostProfile>> | undefined
  const transferTimings: RemoteUploadPhaseTiming[] = []

  try {
    provider = await step('loopback provider started with a random test-only bearer token', () =>
      startLoopbackProvider(token)
    )
    if (options.target === 'ssh') {
      ssh = await step('SSH master connected', () =>
        connectRemoteSshSession({ host: options.host!, userInitiated: true })
      )
      remoteProfile = await step('remote host profile probed', () =>
        probeRemoteKernelHostProfile(ssh!, AbortSignal.timeout(30_000))
      )
      await step('marker-backed remote helper prepared', () =>
        prepareKernelE2eRemoteHelper({
          session: ssh!,
          profile: remoteProfile!,
          hostAlias: options.host!,
          runtimeRoot: options.runtimeRoot,
          helperPath: options.helperPath,
          signal: AbortSignal.timeout(180_000)
        })
      )
      tunnel = await step('reverse tunnel allocated on remote loopback', () =>
        ssh!.openReverseTunnel!({ localPort: provider!.port })
      )
      files = remoteFiles(ssh, options.runtimeRoot)
    } else {
      await mkdir(options.runtimeRoot, { recursive: true })
      files = localFiles(options.runtimeRoot)
    }
    await step('temporary projects prepared', () => files!.prepare())

    const readyStarted = process.hrtime.bigint()
    if (options.target === 'ssh') {
      remoteLaunch = await step('remote kernel deployed and launched', () =>
        launchRemoteKernel({
          session: ssh!,
          runtimeRoot: options.runtimeRoot,
          buildDirectory: options.buildDirectory,
          profile: remoteProfile,
          agentDir: files!.paths.agentDir,
          home: files!.paths.home,
          ...(options.scenario === 'grace-expiry' ||
          options.scenario === 'baseline' ||
          options.scenario === 'tools' ||
          options.scenario === 'plan'
            ? { graceMs: 500 }
            : {}),
          hello: { hostCapabilities: [...KERNEL_E2E_HOST_CAPABILITIES] },
          signal: AbortSignal.timeout(deployBudget!.deployTimeoutMs),
          uploadOptions: {
            onPhaseTiming: (timing) => transferTimings.push(timing)
          },
          onDiagnostic: (text) => process.stderr.write(`[remote-kernel] ${text}`)
        })
      )
      report.hostProfile = remoteLaunch.profile
      report.deploy = {
        outcome: remoteLaunch.deployment.reused ? 'reused' : 'fresh',
        remoteCommandCount: remoteLaunch.remoteCommandCount,
        executablePath: remoteLaunch.deployment.executablePath,
        nativePath: remoteLaunch.deployment.nativePath,
        transferTimings
      }
      report.timingsMs.ready = remoteLaunch.readyMs
      report.cleanup.deployedKernelRemovalCommand = `rm -rf -- ${shellQuote(posix.dirname(remoteLaunch.deployment.executablePath))}`
    } else {
      const executable = join(options.buildDirectory, 'phi-kernel')
      localLaunch = await step('local compiled kernel launched', () =>
        launchLocalKernel({
          executable,
          hello: { hostCapabilities: [...KERNEL_E2E_HOST_CAPABILITIES] },
          agentDir: files!.paths.agentDir,
          home: files!.paths.home,
          cwd: files!.paths.home,
          env: {
            PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
            XDG_CONFIG_HOME: join(files!.paths.home, '.config'),
            XDG_CACHE_HOME: join(files!.paths.home, '.cache'),
            XDG_DATA_HOME: join(files!.paths.home, '.local', 'share'),
            TMPDIR: join(files!.paths.root, 'tmp'),
            TMP: join(files!.paths.root, 'tmp'),
            TEMP: join(files!.paths.root, 'tmp'),
            OMP_APP_NAME: 'Phi',
            NO_PROXY: '127.0.0.1,localhost',
            no_proxy: '127.0.0.1,localhost',
            LANG: process.env.LANG ?? 'C.UTF-8'
          },
          onDiagnostic: (text) => process.stderr.write(`[local-kernel] ${text}`)
        })
      )
      report.deploy.executablePath = executable
    }
    if (options.target === 'local') report.timingsMs.ready = elapsedMs(readyStarted)
    const launch = remoteLaunch ?? localLaunch!
    report.versions = {
      phi: packageVersion,
      kernel: launch.greeting.kernel.version,
      omp: launch.greeting.kernel.ompVersion
    }
    // A remote kernel takes its model catalog only from the desktop (K2-3 client proxy).
    if (options.target === 'ssh') {
      await configureInitialModelProxy({
        client: launch.client,
        tunnel: tunnel!,
        bearerToken: token,
        report,
        step
      })
    } else {
      await step('agent model configuration written', () =>
        files!.writeAgentConfig(provider!.url, token)
      )
    }
    scenario = new ScenarioClient(launch.client)
    await step('event subscription established', () =>
      bounded(launch.client.subscribe(0), 'event subscription')
    )
    launch.client.registerHostHandler('settings.nextActionSuggestionsEnabled', () => false)
    launch.client.registerHostHandler('skills.scriptTools', () => ({ tools: [] }))

    if (options.scenario === 'plan') {
      await runPlanScenario({
        provider,
        client: scenario,
        projectRoot: files.paths.projectA,
        report,
        step
      })
      report.ok = report.steps.every((item) => item.passed)
      return report
    }

    if (options.scenario === 'tools') {
      await runToolsScenario({
        provider,
        client: scenario,
        files: {
          projectRoot: files.paths.projectA,
          projectPath: (relativePath) => files!.projectPath(relativePath),
          homePath: (relativePath) => files!.homePath(relativePath),
          write: (path, content) => files!.write(path, content)
        },
        report,
        step
      })
      report.ok = report.steps.every((item) => item.passed)
      return report
    }

    if (options.scenario === 'model-proxy-reconnect') {
      const reconnected = await runSshModelProxyReconnectScenario({
        session: ssh!,
        launch: remoteLaunch!,
        initialTunnel: tunnel!,
        client: scenario,
        createClient(client) {
          const created = new ScenarioClient(client)
          client.registerHostHandler('settings.nextActionSuggestionsEnabled', () => false)
          client.registerHostHandler('skills.scriptTools', () => ({ tools: [] }))
          return created
        },
        provider,
        files,
        bearerToken: token,
        report,
        step,
        onDiagnostic: (text) => process.stderr.write(`[remote-kernel] ${text}`)
      })
      remoteLaunch = reconnected.remoteLaunch
      scenario = reconnected.scenario
      tunnel = reconnected.tunnel
      report.ok = report.steps.every((item) => item.passed)
      return report
    }

    if (options.scenario !== 'baseline') {
      const lifecycle = await runSshLifecycleScenario({
        scenario: options.scenario,
        session: ssh!,
        launch: remoteLaunch!,
        client: scenario,
        createClient(client) {
          const created = new ScenarioClient(client)
          client.registerHostHandler('settings.nextActionSuggestionsEnabled', () => false)
          client.registerHostHandler('skills.scriptTools', () => ({ tools: [] }))
          return created
        },
        afterReattach: (client) => configureModelProxy(client, tunnel!, token),
        provider,
        files,
        report,
        step,
        onDiagnostic: (text) => process.stderr.write(`[remote-kernel] ${text}`)
      })
      remoteLaunch = lifecycle.remoteLaunch
      scenario = lifecycle.scenario
      report.ok = report.steps.every((item) => item.passed)
      return report
    }

    let approvalFailure: Error | undefined
    const stopApprovals = launch.client.onEvent((event) => {
      if (event.type !== 'approval.requested' || !event.sessionId) return
      report.evidence.approvalCount++
      void (async () => {
        try {
          const payload = record(event.payload)
          if (payload.toolName === 'write') {
            report.evidence.approvalObservedBeforeWrite = !(await files!.exists(
              files!.paths.writtenFile
            ))
          }
          const approvalId = payload.approvalId
          if (typeof approvalId !== 'string') {
            throw new TypeError('Approval event omitted approvalId')
          }
          await bounded(
            launch.client.request(
              'approval.respond',
              { approvalId, decision: 'approved' },
              { sessionId: event.sessionId }
            ),
            'approval response'
          )
        } catch (error) {
          approvalFailure = error instanceof Error ? error : new Error(String(error))
        }
      })()
    })

    try {
      const createAStarted = process.hrtime.bigint()
      const sessionA = await step('session A created', () =>
        scenario!.create(files!.paths.projectA, true)
      )
      report.timingsMs.firstSessionCreate = elapsedMs(createAStarted)
      if (localLaunch?.process.pid) {
        report.memoryKb.afterOneSession = await files.sampleRss(localLaunch.process.pid)
      }

      provider.enqueue(
        { tool: { name: 'read', id: 'a-read', args: { path: 'shared.txt' } } },
        {
          tool: {
            name: 'write',
            id: 'a-write',
            args: { path: files.paths.writtenFile, content: 'G1_APPROVED_WRITE\n' }
          }
        },
        {
          tool: {
            name: 'bash',
            id: 'a-identity',
            args: {
              command:
                'export PHI_G1_A=only-a; printf \'CWD=%s ENV_A=%s ENV_B=%s KERNEL_PID=%s\' "$PWD" "$PHI_G1_A" "${PHI_G1_B-unset}" "$$"'
            }
          }
        },
        { text: 'SESSION_A_INITIAL_COMPLETE' }
      )
      const aInitialStarted = process.hrtime.bigint()
      await step('session A read, approved write, and identity turn completed', async () => {
        const completion = await scenario!.prompt(sessionA, 'Run the scripted G1 initial turn.')
        assert.equal(completion.status, 'completed')
        if (approvalFailure) throw approvalFailure
      })
      report.timingsMs.turns.sessionAInitial = elapsedMs(aInitialStarted)
      const snapshotA = await scenario.snapshot(sessionA)
      const bashA = toolEvidence(snapshotA, 'bash')
      await step('session A file, approval, cwd, and environment evidence verified', async () => {
        const evidenceA = JSON.stringify(snapshotA)
        assert.match(evidenceA, /ONLY_SESSION_A/)
        assert.doesNotMatch(evidenceA, /ONLY_SESSION_B/)
        assert.equal(await files!.read(files!.paths.writtenFile), 'G1_APPROVED_WRITE\n')
        assert.equal(report.evidence.approvalObservedBeforeWrite, true)
        assert.match(
          bashA,
          new RegExp(`CWD=${files!.paths.projectA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
        )
        assert.match(bashA, /ENV_A=only-a/)
        assert.match(bashA, /ENV_B=unset/)
        report.evidence.kernelPidA = extractKernelPid(bashA)
      })
      const kernelPidA = report.evidence.kernelPidA
      if (kernelPidA === undefined) throw new Error('Session A omitted kernel PID evidence')

      if (options.target === 'ssh') {
        report.memoryKb.afterOneSession = await files.sampleRss(kernelPidA)
      } else {
        assert.equal(report.evidence.kernelPidA, localLaunch!.process.pid)
        report.memoryKb.afterOneSession = await files.sampleRss(localLaunch!.process.pid!)
      }

      provider.enqueue({
        tool: {
          name: 'bash',
          id: 'a-long',
          args: {
            command: `sh -c 'printf "%s" "$$" > "$1"; exec sleep 30' sh ${shellLiteral(files.paths.childPidFile)}`
          }
        }
      })
      const longStarted = process.hrtime.bigint()
      const longPrompt = scenario.prompt(sessionA, 'Run the cancellable foreground child.')
      void longPrompt.catch(() => undefined)
      await step('long native child started', async () => {
        await eventually(
          async () =>
            (await files!.exists(files!.paths.childPidFile)) &&
            (await files!.read(files!.paths.childPidFile)).trim().length > 0,
          'long native child pidfile'
        )
      })
      const childPid = Number((await files.read(files.paths.childPidFile)).trim())
      await step('long native child PID verified', async () => {
        assert.ok(Number.isSafeInteger(childPid) && childPid > 0)
        assert.equal(await files!.processAlive(childPid), true)
      })
      report.evidence.longChildPid = childPid

      const sessionB = await step('session B created while session A was running', () =>
        scenario!.create(files!.paths.projectB, false)
      )
      provider.enqueue(
        { tool: { name: 'read', id: 'b-read', args: { path: 'shared.txt' } } },
        {
          tool: {
            name: 'bash',
            id: 'b-identity',
            args: {
              command:
                'export PHI_G1_B=only-b; printf \'CWD=%s ENV_A=%s ENV_B=%s KERNEL_PID=%s\' "$PWD" "${PHI_G1_A-unset}" "$PHI_G1_B" "$$"'
            }
          }
        },
        { text: 'SESSION_B_COMPLETE' }
      )
      const bStarted = process.hrtime.bigint()
      await step('session B completed concurrently and stayed isolated', async () => {
        const completion = await scenario!.prompt(sessionB, 'Inspect only session B state.')
        assert.equal(completion.status, 'completed', completion.detail)
      })
      report.timingsMs.turns.sessionBConcurrent = elapsedMs(bStarted)
      const snapshotB = await scenario.snapshot(sessionB)
      const bashB = toolEvidence(snapshotB, 'bash')
      await step('session B isolation and shared-kernel evidence verified', async () => {
        const evidenceB = JSON.stringify(snapshotB)
        assert.match(evidenceB, /ONLY_SESSION_B/)
        assert.doesNotMatch(evidenceB, /ONLY_SESSION_A/)
        assert.match(
          bashB,
          new RegExp(`CWD=${files!.paths.projectB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
        )
        assert.match(bashB, /ENV_A=unset/)
        assert.match(bashB, /ENV_B=only-b/)
        report.evidence.kernelPidB = extractKernelPid(bashB)
        assert.equal(report.evidence.kernelPidB, report.evidence.kernelPidA)
        assert.equal(await files!.processAlive(childPid), true)
      })
      report.memoryKb.afterTwoSessions = await files.sampleRss(kernelPidA)

      const abortStarted = process.hrtime.bigint()
      await step('session A abort stopped the foreground child', async () => {
        await bounded(
          launch.client.request('session.abort', {}, { sessionId: sessionA }),
          'session.abort'
        )
        const completion = await longPrompt
        assert.equal(completion.status, 'cancelled')
        await eventually(async () => !(await files!.processAlive(childPid)), 'long child exit')
      })
      report.timingsMs.abortToExit = elapsedMs(abortStarted)
      report.timingsMs.turns.sessionALongUntilCancel = elapsedMs(longStarted)

      provider.enqueue({ text: 'SESSION_A_REUSED' })
      const reuseStarted = process.hrtime.bigint()
      await step('session A was reusable after abort', async () => {
        const completion = await scenario!.prompt(sessionA, 'Continue after cancellation.')
        assert.equal(completion.status, 'completed')
        assert.match(JSON.stringify(await scenario!.snapshot(sessionA)), /SESSION_A_REUSED/)
      })
      report.timingsMs.turns.sessionAReuse = elapsedMs(reuseStarted)
    } finally {
      stopApprovals()
    }
    report.ok = report.steps.every((item) => item.passed)
    return report
  } catch (error) {
    report.failure = errorMessage(error)
    return report
  } finally {
    scenario?.close()
    if (remoteLaunch && ssh) {
      const cleanupStarted = process.hrtime.bigint()
      await bounded(
        shutdownSshScenarioKernel({ session: ssh, launch: remoteLaunch }),
        'remote kernel shutdown cleanup',
        90_000
      )
        .then(() => {
          report.steps.push({
            name: 'remote kernel shut down and socket files removed',
            passed: true,
            elapsedMs: elapsedMs(cleanupStarted)
          })
        })
        .catch((error) => {
          const reason = errorMessage(error)
          report.failure ??= reason
          report.steps.push({
            name: 'remote kernel shut down and socket files removed',
            passed: false,
            reason,
            elapsedMs: elapsedMs(cleanupStarted)
          })
        })
    }
    if (localLaunch) {
      await bounded(localLaunch.close(), 'local kernel cleanup', 15_000).catch(() => undefined)
    }
    if (files) {
      await bounded(files.cleanup(), 'temporary project cleanup', 90_000)
        .then(() => {
          report.cleanup.temporaryProjectsRemoved = true
        })
        .catch((error) => {
          report.steps.push({
            name: 'temporary project cleanup',
            passed: false,
            reason: errorMessage(error),
            elapsedMs: 0
          })
        })
    }
    if (tunnel) {
      await bounded(tunnel.close(), 'reverse tunnel cleanup', 15_000).catch(() => undefined)
    }
    if (ssh) await bounded(ssh.close(), 'SSH cleanup', 30_000).catch(() => undefined)
    if (provider) await bounded(provider.close(), 'provider cleanup', 15_000).catch(() => undefined)
    report.ok = report.failure === undefined && report.steps.every((item) => item.passed)
  }
}

async function main(): Promise<void> {
  let options: KernelE2eCliOptions
  try {
    options = parseKernelE2eArgs(Bun.argv.slice(2), packageVersion)
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exit(2)
  }
  const report = await runScenario(options)
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, json)
  }
  process.stdout.write(json)
  if (report.cleanup.deployedKernelRemovalCommand) {
    process.stderr.write(
      `Deployed kernel retained for reuse. Remove it on the host with:\n${report.cleanup.deployedKernelRemovalCommand}\n`
    )
  }
  if (!report.ok) process.exitCode = 1
}

await main()
