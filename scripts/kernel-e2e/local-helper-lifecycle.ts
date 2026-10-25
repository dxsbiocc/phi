#!/usr/bin/env bun

import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { KernelClientError, KernelProtocolClient } from '../../src/main/agent/engine/kernel-client'
import {
  RemoteKernelTransport,
  type RemoteKernelAttachStatus
} from '../../src/main/agent/engine/kernel-client/remote'
import type { RemoteStdioProcess } from '../../src/main/agent/wrappers/remote-ssh-session'
import {
  agentConfig,
  bounded,
  errorMessage,
  ScenarioClient,
  startLoopbackProvider
} from './harness'
import { eventually, KERNEL_E2E_HOST_CAPABILITIES, shellLiteral } from './lifecycle-scenarios'

type Scenario = 'reconnect' | 'grace-expiry' | 'wrong-token'

interface CliOptions {
  scenario: Scenario
  kernel: string
  helper: string
  runtimeRoot: string
  output?: string
  cleanupRuntimeRoot: boolean
}

interface HelperAttachment {
  client: KernelProtocolClient
  greeting: Awaited<ReturnType<KernelProtocolClient['hello']>>
  status: RemoteKernelAttachStatus
  close(): Promise<void>
}

const packageVersion = (
  JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }
).version
const helperVersion = readFileSync(resolve('helper', 'VERSION'), 'utf8').trim()

function usage(): string {
  return [
    'Usage: bun scripts/kernel-e2e/local-helper-lifecycle.ts',
    '       --scenario reconnect|grace-expiry|wrong-token',
    '       [--kernel <compiled-darwin-kernel>] [--helper <darwin-phi-helper>]',
    '       [--runtime-root <absolute-path>] [--out <report.json>]',
    '',
    'Defaults use .phi-build/kernel and .phi-build/helper Darwin arm64 artifacts.'
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
    if (!['--scenario', '--kernel', '--helper', '--runtime-root', '--out'].includes(key)) {
      throw new Error(`Unknown argument: ${key}\n${usage()}`)
    }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}\n${usage()}`)
    values.set(key, value)
  }
  const scenario = values.get('--scenario')
  if (scenario !== 'reconnect' && scenario !== 'grace-expiry' && scenario !== 'wrong-token') {
    throw new Error(`--scenario is required\n${usage()}`)
  }
  const suppliedRoot = values.get('--runtime-root')
  if (suppliedRoot && (!isAbsolute(suppliedRoot) || /[\0\r\n]/.test(suppliedRoot))) {
    throw new Error('--runtime-root must be an absolute path without control characters')
  }
  const runtimeRoot = suppliedRoot
    ? resolve(suppliedRoot)
    : join(tmpdir(), `phi-k2-1b-local-${process.pid}-${Date.now()}`)
  return {
    scenario,
    kernel: resolve(
      values.get('--kernel') ??
        join('.phi-build', 'kernel', packageVersion, 'darwin-arm64', 'phi-kernel')
    ),
    helper: resolve(
      values.get('--helper') ??
        join('.phi-build', 'helper', helperVersion, 'darwin-arm64', 'phi-helper')
    ),
    runtimeRoot,
    ...(values.has('--out') ? { output: resolve(values.get('--out')!) } : {}),
    cleanupRuntimeRoot: suppliedRoot === undefined
  }
}

class LocalHelperProcess implements RemoteStdioProcess {
  readonly stdin
  readonly stdout
  readonly stderr
  readonly closed: Promise<{ code: number | null; signal: string | null }>

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.stdin = child.stdin
    this.stdout = child.stdout
    this.stderr = child.stderr
    this.closed = new Promise((complete, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => complete({ code, signal }))
    })
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.stdin.end()
    await bounded(this.closed, 'phi-helper channel close', 5_000).catch(() => {
      this.child.kill('SIGKILL')
    })
  }
}

async function openHelper(options: {
  cli: CliOptions
  home: string
  agentDir: string
  graceMs: number
  takeover: boolean
  configureClient?: (client: KernelProtocolClient) => void
}): Promise<HelperAttachment> {
  const child = spawn(
    options.cli.helper,
    [
      'attach',
      '--kernel',
      options.cli.kernel,
      '--runtime-root',
      options.cli.runtimeRoot,
      '--kernel-version',
      packageVersion,
      '--grace-ms',
      String(options.graceMs),
      ...Object.entries({
        PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: options.home,
        PI_CODING_AGENT_DIR: options.agentDir,
        OMP_APP_NAME: 'Phi',
        XDG_CONFIG_HOME: join(options.home, '.config'),
        XDG_CACHE_HOME: join(options.home, '.cache'),
        XDG_DATA_HOME: join(options.home, '.local', 'share'),
        TMPDIR: join(options.cli.runtimeRoot, 'tmp'),
        TMP: join(options.cli.runtimeRoot, 'tmp'),
        TEMP: join(options.cli.runtimeRoot, 'tmp'),
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        LANG: process.env.LANG ?? 'C.UTF-8'
      }).flatMap(([name, value]) => ['--env', `${name}=${value}`])
    ],
    {
      cwd: options.home,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  const processAdapter = new LocalHelperProcess(child)
  const diagnostics: string[] = []
  const transport = new RemoteKernelTransport(processAdapter, (text) => diagnostics.push(text))
  const client = new KernelProtocolClient(transport)
  options.configureClient?.(client)
  try {
    const [greeting, status] = await bounded(
      Promise.all([
        client.hello({
          takeover: options.takeover,
          hostCapabilities: [...KERNEL_E2E_HOST_CAPABILITIES]
        }),
        transport.attachStatus
      ]),
      'phi-helper attach handshake',
      35_000
    )
    return { client, greeting, status, close: () => client.close() }
  } catch (error) {
    await client.close().catch(() => undefined)
    throw new Error(
      `Local phi-helper attach failed${diagnostics.length ? `: ${diagnostics.join('').trim()}` : ''}`,
      { cause: error }
    )
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function socketPath(runtimeRoot: string): string {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid)) throw new Error('Cannot determine the current uid')
  const stem = createHash('sha256')
    .update(runtimeRoot)
    .update('\0')
    .update(packageVersion)
    .digest('hex')
    .slice(0, 16)
  return `/tmp/phi-k-${uid}/${stem}.sock`
}

async function wrongTokenRejected(path: string): Promise<void> {
  const received: Buffer[] = []
  let socket: ReturnType<typeof createConnection> | undefined
  try {
    await bounded(
      new Promise<void>((complete, reject) => {
        const connection = createConnection(path)
        socket = connection
        connection.on('data', (chunk) => received.push(Buffer.from(chunk)))
        connection.once('error', reject)
        connection.once('close', complete)
        connection.once('connect', () => {
          connection.write(`${JSON.stringify({ phiKernelAttach: 1, token: '0'.repeat(64) })}\n`)
          connection.write('{"kind":"request"}\n')
        })
      }),
      'wrong-token socket rejection',
      5_000
    )
  } finally {
    socket?.destroy()
  }
  assert.equal(Buffer.concat(received).byteLength, 0)
}

async function main(): Promise<void> {
  let cli: CliOptions
  try {
    cli = parseArgs(Bun.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exit(2)
  }
  for (const [label, path] of [
    ['kernel', cli.kernel],
    ['helper', cli.helper]
  ] as const) {
    if (!existsSync(path)) throw new Error(`Compiled Darwin ${label} is missing: ${path}`)
  }

  const home = join(cli.runtimeRoot, 'home')
  const agentDir = join(cli.runtimeRoot, 'agent')
  const project = join(cli.runtimeRoot, 'project')
  const childPidFile = join(project, 'long-child.pid')
  for (const directory of [
    cli.runtimeRoot,
    home,
    agentDir,
    project,
    join(home, '.config'),
    join(home, '.cache'),
    join(home, '.local', 'share'),
    join(cli.runtimeRoot, 'tmp')
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  const token = randomBytes(32).toString('base64url')
  const provider = await startLoopbackProvider(token)
  const config = agentConfig(provider.url, token)
  writeFileSync(join(agentDir, 'models.yml'), config.models)
  writeFileSync(join(agentDir, 'config.yml'), config.config)
  let attachment: HelperAttachment | undefined
  let scenario: ScenarioClient | undefined
  const result: Record<string, unknown> = { scenario: cli.scenario, ok: false }
  try {
    attachment = await openHelper({
      cli,
      home,
      agentDir,
      graceMs: cli.scenario === 'grace-expiry' ? 500 : 3_000,
      takeover: false,
      configureClient(client) {
        scenario = new ScenarioClient(client)
        client.registerHostHandler('settings.nextActionSuggestionsEnabled', () => false)
        client.registerHostHandler('skills.scriptTools', () => ({ tools: [] }))
      }
    })
    assert.equal(attachment.status.state, 'spawned', 'use a fresh --runtime-root for this scenario')
    const kernelPid = attachment.status.pid
    result.kernelPid = kernelPid
    result.kernelInstanceId = attachment.greeting.kernelInstanceId
    await bounded(attachment.client.subscribe(0), 'initial event subscription')

    if (cli.scenario === 'wrong-token') {
      await wrongTokenRejected(socketPath(cli.runtimeRoot))
      await attachment.close()
      attachment = undefined
      await eventually(() => !processAlive(kernelPid), 'kernel exit after wrong-token check')
      result.wrongTokenRejected = true
      result.kernelExited = true
      result.ok = true
      return
    }

    const sessionId = await scenario!.create(project, false)
    provider.enqueue(
      {
        tool: {
          name: 'bash',
          id: 'local-lifecycle-child',
          args: {
            command: `sh -c 'printf "%s" "$$" > "$1"; exec sleep ${
              cli.scenario === 'reconnect' ? '2' : '60'
            }' sh ${shellLiteral(childPidFile)}`
          }
        }
      },
      ...(cli.scenario === 'reconnect' ? ([{ text: 'LOCAL_RECONNECT_COMPLETE' }] as const) : [])
    )
    const runId = await scenario!.startPrompt(sessionId, 'Run the local helper lifecycle command.')
    await eventually(() => existsSync(childPidFile), 'local lifecycle child pidfile')
    const childPid = Number(readFileSync(childPidFile, 'utf8').trim())
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0)
    result.childPid = childPid
    const lastSeen = scenario!.lastSeen
    scenario!.close()
    scenario = undefined
    await attachment.close()
    attachment = undefined

    if (cli.scenario === 'grace-expiry') {
      await eventually(
        () => !processAlive(kernelPid) && !processAlive(childPid),
        'local kernel and child exit after grace expiry'
      )
      result.kernelExited = true
      result.childExited = true
      result.ok = true
      return
    }

    attachment = await openHelper({
      cli,
      home,
      agentDir,
      graceMs: 3_000,
      takeover: true,
      configureClient(client) {
        scenario = new ScenarioClient(client)
        client.registerHostHandler('settings.nextActionSuggestionsEnabled', () => false)
        client.registerHostHandler('skills.scriptTools', () => ({ tools: [] }))
      }
    })
    assert.deepEqual(attachment.status, { state: 'attached' })
    assert.equal(attachment.greeting.kernelInstanceId, result.kernelInstanceId)
    try {
      await attachment.client.subscribe(lastSeen)
    } catch (error) {
      if (error instanceof KernelClientError && error.code === 'REPLAY_GAP') {
        throw new Error('Reconnect unexpectedly required a snapshot', { cause: error })
      }
      throw error
    }
    const completion = await scenario!.waitForRun(runId)
    assert.equal(completion.status, 'completed')
    scenario!.close()
    scenario = undefined
    await attachment.close()
    attachment = undefined
    await eventually(() => !processAlive(kernelPid), 'kernel exit after reconnect check')
    result.replayedCompletion = true
    result.kernelExited = true
    result.ok = true
  } finally {
    scenario?.close()
    await attachment?.close().catch(() => undefined)
    await provider.close().catch(() => undefined)
    if (cli.cleanupRuntimeRoot) rmSync(cli.runtimeRoot, { recursive: true, force: true })
    if (cli.output) {
      await mkdir(dirname(cli.output), { recursive: true })
      await writeFile(cli.output, `${JSON.stringify(result, null, 2)}\n`)
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }
}

await main()
