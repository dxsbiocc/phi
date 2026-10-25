#!/usr/bin/env bun

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, isAbsolute, join, posix, resolve } from 'node:path'

import {
  launchLocalKernel,
  type KernelProtocolClient,
  type LocalKernelLauncher
} from '../src/main/agent/engine/kernel-client'
import {
  launchRemoteKernel,
  type LaunchedRemoteKernel
} from '../src/main/agent/engine/kernel-client/remote'
import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteReverseTunnel,
  type RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import type { JsonValue, KernelEventFrame } from '../src/shared/kernel-protocol'

type Target = 'local' | 'ssh'

interface CliOptions {
  target: Target
  runtimeRoot: string
  host?: string
  buildDirectory: string
  output?: string
}

interface ModelReply {
  text?: string
  tool?: { name: string; id: string; args: Record<string, unknown> }
}

interface ModelRequest {
  messages: Array<Record<string, unknown>>
  tools?: unknown[]
}

interface StepResult {
  name: string
  passed: boolean
  reason?: string
  elapsedMs: number
}

interface E2eReport {
  schemaVersion: 1
  ok: boolean
  target: Target
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
    executablePath: string
    nativePath?: string
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
  evidence: {
    kernelPidA?: number
    kernelPidB?: number
    longChildPid?: number
    approvalCount: number
    approvalObservedBeforeWrite: boolean
    bearerToken: 'random-test-only-not-recorded'
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
  prepare(): Promise<void>
  writeAgentConfig(baseUrl: string, token: string): Promise<void>
  read(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  processAlive(pid: number): Promise<boolean>
  sampleRss(pid: number): Promise<number | null>
  cleanup(): Promise<void>
}

const PROVIDER_ID = 'phi-kernel-e2e'
const MODEL_ID = 'scripted-g1'
const packageVersion = (
  JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    version: string
  }
).version

function usage(): string {
  return [
    'Usage: bun scripts/kernel-e2e.ts --target local|ssh --runtime-root <absolute-path>',
    '       [--host <ssh-alias>] [--build-dir <target-build-directory>] [--out <report.json>]',
    '',
    'SSH mode requires --host. The provider bearer token is random and valid only for this run.'
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`)
    process.exit(0)
  }
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!['--target', '--host', '--runtime-root', '--build-dir', '--out'].includes(key)) {
      throw new Error(`Unknown argument: ${key}\n${usage()}`)
    }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}\n${usage()}`)
    values.set(key, value)
  }
  const target = values.get('--target')
  if (target !== 'local' && target !== 'ssh') throw new Error(`--target is required\n${usage()}`)
  const runtimeRoot = values.get('--runtime-root')
  if (!runtimeRoot || !isAbsolute(runtimeRoot) || /[\0\r\n]/.test(runtimeRoot)) {
    throw new Error('--runtime-root must be an absolute path without control characters')
  }
  const host = values.get('--host')
  if (target === 'ssh' && !host) throw new Error(`SSH mode requires --host\n${usage()}`)
  const defaultTarget = target === 'ssh' ? 'linux-x64' : 'darwin-arm64'
  return {
    target,
    runtimeRoot: target === 'ssh' ? posix.normalize(runtimeRoot) : resolve(runtimeRoot),
    ...(host ? { host } : {}),
    buildDirectory: resolve(
      values.get('--build-dir') ?? join('.phi-build', 'kernel', packageVersion, defaultTarget)
    ),
    ...(values.has('--out') ? { output: resolve(values.get('--out')!) } : {})
  }
}

function record(value: JsonValue | unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).join('')
  if (!value || typeof value !== 'object') return ''
  const item = value as Record<string, unknown>
  return typeof item.text === 'string' ? item.text : contentText(item.content)
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function bounded<T>(operation: Promise<T>, label: string, timeoutMs = 60_000): Promise<T> {
  return new Promise<T>((resolveOperation, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label} after ${timeoutMs} ms.`)),
      timeoutMs
    )
    operation.then(
      (value) => {
        clearTimeout(timeout)
        resolveOperation(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

async function eventually(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(20)
  }
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function startLoopbackProvider(token: string): Promise<{
  url: string
  port: number
  requests: ModelRequest[]
  enqueue(...replies: ModelReply[]): void
  close(): Promise<void>
}> {
  const requests: ModelRequest[] = []
  const replies: ModelReply[] = []
  const active = new Set<ServerResponse>()
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end('Unexpected test endpoint')
        return
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end('Invalid test bearer token')
        return
      }
      let body = ''
      for await (const chunk of request) body += chunk
      const parsed = JSON.parse(body) as ModelRequest
      requests.push(parsed)
      const taskAssessment =
        parsed.messages.length === 2 &&
        parsed.messages.some(
          (message) =>
            (message.role === 'system' || message.role === 'developer') &&
            typeof message.content === 'string' &&
            message.content.includes('Is this specialist suitable for the exact delegated task')
        ) &&
        (!Array.isArray(parsed.tools) || parsed.tools.length === 0)
      const reply = taskAssessment ? { text: 'suitable' } : replies.shift()
      if (!reply) {
        response.writeHead(500).end('No scripted reply remains')
        return
      }
      active.add(response)
      response.on('close', () => active.delete(response))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finishReason: string | null = null): void => {
        response.write(
          `data: ${JSON.stringify({
            id: `g1-${requests.length}`,
            object: 'chat.completion.chunk',
            created: 0,
            model: MODEL_ID,
            choices: [{ index: 0, delta, finish_reason: finishReason }]
          })}\n\n`
        )
      }
      chunk({ role: 'assistant', content: '' })
      if (reply.text) {
        const split = Math.max(1, Math.floor(reply.text.length / 2))
        chunk({ content: reply.text.slice(0, split) })
        chunk({ content: reply.text.slice(split) })
      }
      if (reply.tool) {
        chunk({
          tool_calls: [
            {
              index: 0,
              id: reply.tool.id,
              type: 'function',
              function: { name: reply.tool.name, arguments: '' }
            }
          ]
        })
        chunk({
          tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.tool.args) } }]
        })
      }
      chunk({}, reply.tool ? 'tool_calls' : 'stop')
      response.write('data: [DONE]\n\n')
      response.end()
    } catch (error) {
      if (!response.headersSent) response.writeHead(500)
      response.end(errorMessage(error))
    }
  })
  await new Promise<void>((complete, reject) => {
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('Timed out starting the loopback provider.'))
    }, 5_000)
    const finish = (action: () => void): void => {
      clearTimeout(timeout)
      server.off('error', onError)
      action()
    }
    const onError = (error: Error): void => finish(() => reject(error))
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => finish(complete))
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    enqueue: (...items) => replies.push(...items),
    async close() {
      for (const response of active) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((complete) => server.close(() => complete()))
    }
  }
}

function agentConfig(baseUrl: string, token: string): { models: string; config: string } {
  return {
    models: JSON.stringify({
      providers: {
        [PROVIDER_ID]: {
          baseUrl,
          apiKey: token,
          api: 'openai-completions',
          models: [
            {
              id: MODEL_ID,
              name: 'G1 scripted loopback',
              reasoning: false,
              input: ['text'],
              contextWindow: 32768,
              maxTokens: 256,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    }),
    config: JSON.stringify({
      compaction: { enabled: false, thresholdPercent: 80, thresholdTokens: -1 },
      mcp: { enableProjectConfig: false },
      defaultProvider: PROVIDER_ID,
      defaultModel: MODEL_ID
    })
  }
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
  const run = async (command: string): Promise<string> => {
    const result = await session.exec(command)
    if (result.code !== 0 || result.signal)
      throw new Error(result.stderr || 'remote command failed')
    return result.stdout
  }
  return {
    paths,
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
      await run(`rm -rf -- ${shellQuote(paths.root)}`)
    }
  }
}

class ScenarioClient {
  private readonly completions = new Map<string, { status: string; detail?: string }>()
  private readonly waiters = new Map<
    string,
    {
      complete(completion: { status: string; detail?: string }): void
      reject(error: Error): void
      timeout: NodeJS.Timeout
    }
  >()
  readonly events: KernelEventFrame[] = []
  private readonly stopEvents: () => void

  constructor(readonly client: KernelProtocolClient) {
    this.stopEvents = client.onEvent((event) => {
      this.events.push(event)
      if (event.type !== 'run.completed') return
      const payload = record(event.payload)
      if (typeof payload.runId !== 'string' || typeof payload.status !== 'string') return
      const completion = {
        status: payload.status,
        ...(typeof payload.detail === 'string' ? { detail: payload.detail } : {})
      }
      this.completions.set(payload.runId, completion)
      const waiter = this.waiters.get(payload.runId)
      if (waiter) {
        clearTimeout(waiter.timeout)
        waiter.complete(completion)
      }
      this.waiters.delete(payload.runId)
    })
  }

  async create(cwd: string, approval: boolean): Promise<string> {
    const result = record(
      await bounded(
        this.client.request('session.create', {
          cwd,
          model: { provider: PROVIDER_ID, id: MODEL_ID },
          sessionManager: { kind: 'memory' },
          enableToolApproval: approval,
          autoCompaction: { enabled: false },
          resourceOptions: {
            noExtensions: true,
            noSkills: true,
            noContextFiles: true,
            noPromptTemplates: true,
            noThemes: true
          }
        }),
        'session.create'
      )
    )
    const sessionId = result.sessionId
    if (typeof sessionId !== 'string') throw new TypeError('Kernel create result omitted sessionId')
    return sessionId
  }

  async prompt(sessionId: string, text: string): Promise<{ runId: string; status: string }> {
    const result = record(
      await bounded(
        this.client.request('session.prompt', { text }, { sessionId }),
        'session.prompt acceptance'
      )
    )
    const runId = result.runId
    if (typeof runId !== 'string') throw new TypeError('Kernel prompt result omitted runId')
    const completion = await this.waitForRun(runId)
    return { runId, status: completion.status }
  }

  async snapshot(sessionId: string): Promise<Record<string, unknown>> {
    return record(
      await bounded(this.client.request('session.snapshot', {}, { sessionId }), 'session.snapshot')
    )
  }

  waitForRun(runId: string): Promise<{ status: string; detail?: string }> {
    const completion = this.completions.get(runId)
    if (completion) return Promise.resolve(completion)
    return new Promise((complete, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(runId)
        reject(new Error(`Timed out waiting for kernel run ${runId}.`))
      }, 60_000)
      this.waiters.set(runId, { complete, reject, timeout })
    })
  }

  close(): void {
    this.stopEvents()
    for (const [runId, waiter] of this.waiters) {
      clearTimeout(waiter.timeout)
      waiter.reject(new Error(`Kernel scenario closed while waiting for run ${runId}.`))
    }
    this.waiters.clear()
  }
}

function toolEvidence(snapshot: Record<string, unknown>, toolName: string): string {
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : []
  return messages
    .filter((message): message is Record<string, unknown> =>
      Boolean(
        message &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).role === 'toolResult' &&
        (message as Record<string, unknown>).toolName === toolName
      )
    )
    .map((message) => contentText(message.content))
    .join('\n')
}

function extractKernelPid(text: string): number {
  const match = text.match(/KERNEL_PID=(\d+)/)
  const pid = Number(match?.[1])
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `Missing kernel PID evidence: ${text}`)
  return pid
}

async function runScenario(options: CliOptions): Promise<E2eReport> {
  const report: E2eReport = {
    schemaVersion: 1,
    ok: false,
    target: options.target,
    ...(options.host ? { host: options.host } : {}),
    hostProfile: { os: process.platform, arch: process.arch },
    versions: { phi: packageVersion, kernel: 'unknown', omp: 'unknown' },
    deploy: {
      outcome: options.target === 'local' ? 'local' : 'fresh',
      remoteCommandCount: 0,
      executablePath: ''
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
  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const started = process.hrtime.bigint()
    try {
      const value = await action()
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

  try {
    provider = await step('loopback provider started with a random test-only bearer token', () =>
      startLoopbackProvider(token)
    )
    if (options.target === 'ssh') {
      ssh = await step('SSH master connected', () =>
        connectRemoteSshSession({ host: options.host!, userInitiated: true })
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
          agentDir: files!.paths.agentDir,
          home: files!.paths.home,
          signal: AbortSignal.timeout(300_000),
          onDiagnostic: (text) => process.stderr.write(`[remote-kernel] ${text}`)
        })
      )
      report.hostProfile = remoteLaunch.profile
      report.deploy = {
        outcome: remoteLaunch.deployment.reused ? 'reused' : 'fresh',
        remoteCommandCount: remoteLaunch.remoteCommandCount,
        executablePath: remoteLaunch.deployment.executablePath,
        nativePath: remoteLaunch.deployment.nativePath
      }
      report.timingsMs.ready = remoteLaunch.readyMs
      report.cleanup.deployedKernelRemovalCommand = `rm -rf -- ${shellQuote(posix.dirname(remoteLaunch.deployment.executablePath))}`
    } else {
      const executable = join(options.buildDirectory, 'phi-kernel')
      localLaunch = await step('local compiled kernel launched', () =>
        launchLocalKernel({
          executable,
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
    const providerUrl =
      options.target === 'ssh' ? `http://127.0.0.1:${tunnel!.remotePort}/v1` : provider.url
    await step('agent model configuration written', () =>
      files!.writeAgentConfig(providerUrl, token)
    )
    scenario = new ScenarioClient(launch.client)
    await bounded(launch.client.subscribe(0), 'event subscription')
    launch.client.registerHostHandler('settings.nextActionSuggestionsEnabled', () => false)
    launch.client.registerHostHandler('skills.scriptTools', () => ({ tools: [] }))

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
        assert.equal(completion.status, 'completed')
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
    await remoteLaunch?.close().catch(() => undefined)
    await localLaunch?.close().catch(() => undefined)
    await files
      ?.cleanup()
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
    await tunnel?.close().catch(() => undefined)
    await ssh?.close().catch(() => undefined)
    await provider?.close().catch(() => undefined)
    report.ok = report.failure === undefined && report.steps.every((item) => item.passed)
  }
}

async function main(): Promise<void> {
  let options: CliOptions
  try {
    options = parseArgs(Bun.argv.slice(2))
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
