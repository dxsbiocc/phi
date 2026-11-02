import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  KernelProtocolClient,
  type KernelClientTransport
} from '../src/main/agent/engine/kernel-client'
import type { JsonValue, KernelEventFrame } from '../src/shared/kernel-protocol'
import { startLoopbackModel } from './engine-contract/loopback-model'

type TargetManifest = {
  phiVersion: string
  ompVersion: string
  nativeVersion: string
  bunVersion: string
  target: 'darwin-arm64'
  files: Array<{
    name: string
    role: 'kernel' | 'native'
    variant?: string
    sha256: string
    size: number
  }>
}

type BuildManifest = {
  phiVersion: string
  ompVersion: string
  nativeVersion: string
  bunVersion: string
  builtAt: string
  buildDurationMs: number
  targets: Array<{ target: string; manifest: string }>
}

type CompiledKernel = {
  client: KernelProtocolClient
  process: ChildProcessWithoutNullStreams
  diagnostics: string[]
  close(): Promise<void>
}

type RuntimeLayout = {
  root: string
  runDirectory: string
  executable: string
  home: string
  agentDir: string
  project: string
  temp: string
  legacyProbe: string
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const suiteRoot = mkdtempSync(path.join(tmpdir(), 'phi-kernel-compiled-suite-'))
const buildRoot = path.join(suiteRoot, 'build')
let targetDirectory = ''
let targetManifest: TargetManifest
let buildManifest: BuildManifest

function packageVersion(packagePath: string): string {
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown }
  const version = metadata.version
  if (typeof version !== 'string' || version.length === 0) {
    assert.fail(`${packagePath} does not declare a version`)
  }
  return version
}

function record(value: JsonValue): Record<string, JsonValue> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value
}

function withTimeout<T>(promise: Promise<T>, message: string, milliseconds = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

class CompiledKernelTransport implements KernelClientTransport {
  private readonly lines
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<() => void>()
  private closed = false

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.lines.on('line', (line) => {
      for (const listener of this.lineListeners) listener(line)
    })
    this.lines.once('close', () => this.notifyClosed())
    child.once('error', () => this.notifyClosed())
    child.once('close', () => this.notifyClosed())
  }

  send(line: string): void {
    if (this.closed) throw new Error('Compiled kernel transport is closed')
    this.child.stdin.write(line)
  }

  onLine(callback: (line: string) => void): void {
    this.lineListeners.add(callback)
  }

  onClose(callback: () => void): void {
    if (this.closed) queueMicrotask(callback)
    else this.closeListeners.add(callback)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.child.stdin.end()
    await new Promise<void>((resolveClose) => {
      let killTimer: NodeJS.Timeout | undefined
      const termTimer = setTimeout(() => {
        this.child.kill('SIGTERM')
        killTimer = setTimeout(() => {
          this.child.kill('SIGKILL')
          resolveClose()
        }, 400)
      }, 1_500)
      this.child.once('close', () => {
        clearTimeout(termTimer)
        if (killTimer) clearTimeout(killTimer)
        resolveClose()
      })
    })
  }

  private notifyClosed(): void {
    if (this.closed) return
    this.closed = true
    this.lines.close()
    for (const listener of this.closeListeners) listener()
    this.closeListeners.clear()
  }
}

function writeAgentConfig(agentDir: string, modelUrl: string): void {
  writeFileSync(
    path.join(agentDir, 'models.yml'),
    JSON.stringify({
      providers: {
        'phi-contract': {
          baseUrl: modelUrl,
          apiKey: `compiled-kernel-test-${randomUUID()}`,
          api: 'openai-completions',
          models: [
            {
              id: 'contract-model',
              name: 'Compiled Kernel Contract Model',
              reasoning: false,
              input: ['text'],
              contextWindow: 32768,
              maxTokens: 256,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  )
  writeFileSync(
    path.join(agentDir, 'config.yml'),
    JSON.stringify({
      compaction: { enabled: false },
      mcp: { enableProjectConfig: false },
      defaultProvider: 'phi-contract',
      defaultModel: 'contract-model'
    })
  )
}

function prepareRuntime(name: string, modelUrl: string): RuntimeLayout {
  const root = path.join(suiteRoot, name)
  const runDirectory = path.join(root, 'relocated')
  const home = path.join(root, 'empty-home')
  const agentDir = path.join(root, 'agent')
  const project = path.join(root, 'project')
  const temp = path.join(root, 'tmp')
  const legacyProbe = path.join(root, 'legacy-root-resolved.txt')
  for (const directory of [runDirectory, home, agentDir, project, temp]) {
    mkdirSync(directory, { recursive: true })
  }

  for (const file of targetManifest.files) {
    copyFileSync(path.join(targetDirectory, file.name), path.join(runDirectory, file.name))
  }
  const executable = path.join(runDirectory, 'phi-kernel')
  chmodSync(executable, 0o755)
  assert.deepEqual(
    readdirSync(runDirectory).sort(),
    ['phi-kernel', 'pi_natives.darwin-arm64.node'],
    'the relocated runtime must contain only the kernel and sibling native addon'
  )
  writeAgentConfig(agentDir, modelUrl)
  return { root, runDirectory, executable, home, agentDir, project, temp, legacyProbe }
}

function launchCompiled(layout: RuntimeLayout): CompiledKernel {
  const diagnostics: string[] = []
  const child = spawn(layout.executable, [], {
    cwd: layout.project,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: layout.home,
      USERPROFILE: layout.home,
      XDG_CONFIG_HOME: path.join(layout.home, '.config'),
      XDG_CACHE_HOME: path.join(layout.home, '.cache'),
      XDG_DATA_HOME: path.join(layout.home, '.local', 'share'),
      TMPDIR: layout.temp,
      TMP: layout.temp,
      TEMP: layout.temp,
      PI_CODING_AGENT_DIR: layout.agentDir,
      PHI_LEGACY_PROBE_PATH: layout.legacyProbe,
      OMP_APP_NAME: 'Phi',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      LANG: process.env.LANG ?? 'C.UTF-8'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => diagnostics.push(chunk))
  const transport = new CompiledKernelTransport(child)
  const client = new KernelProtocolClient(transport)
  client.registerHostHandler('settings.nextActionSuggestionsEnabled', () => false)
  client.registerHostHandler('skills.scriptTools', () => ({ tools: [] }))
  return {
    client,
    process: child,
    diagnostics,
    close: () => client.close()
  }
}

async function createSession(
  client: KernelProtocolClient,
  layout: RuntimeLayout,
  noExtensions: boolean
): Promise<string> {
  const result = record(
    await client.request('session.create', {
      cwd: layout.project,
      model: { provider: 'phi-contract', id: 'contract-model' },
      sessionManager: { kind: 'memory' },
      resourceOptions: {
        noExtensions,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true
      },
      enableToolApproval: false,
      autoCompaction: { enabled: false }
    })
  )
  assert.equal(typeof result.sessionId, 'string')
  return result.sessionId as string
}

before(
  () => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return
    const build = spawnSync('bun', ['scripts/build-kernel.ts', '--target', 'darwin-arm64'], {
      cwd: repoRoot,
      env: { ...process.env, PHI_KERNEL_BUILD_ROOT: buildRoot },
      encoding: 'utf8',
      timeout: 120_000
    })
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)
    const phiVersion = packageVersion(path.join(repoRoot, 'package.json'))
    targetDirectory = path.join(buildRoot, phiVersion, 'darwin-arm64')
    targetManifest = JSON.parse(
      readFileSync(path.join(targetDirectory, 'manifest.json'), 'utf8')
    ) as TargetManifest
    buildManifest = JSON.parse(
      readFileSync(path.join(buildRoot, phiVersion, 'manifest.json'), 'utf8')
    ) as BuildManifest
  },
  { timeout: 125_000 }
)

after(() => rmSync(suiteRoot, { recursive: true, force: true }))

test(
  'darwin build manifest is relocatable and resolves the bundled legacy coding-agent root',
  {
    timeout: 45_000,
    skip: process.platform !== 'darwin' || process.arch !== 'arm64'
  },
  async () => {
    assert.equal(targetManifest.target, 'darwin-arm64')
    assert.equal(targetManifest.phiVersion, packageVersion(path.join(repoRoot, 'package.json')))
    assert.equal(
      targetManifest.ompVersion,
      packageVersion(path.join(repoRoot, 'node_modules/@oh-my-pi/pi-coding-agent/package.json'))
    )
    assert.equal(targetManifest.nativeVersion, '18.10.3')
    assert.ok(!('builtAt' in targetManifest), 'per-target manifest must not contain a timestamp')
    assert.equal(Number.isNaN(Date.parse(buildManifest.builtAt)), false)
    assert.ok(buildManifest.buildDurationMs >= 0)
    assert.deepEqual(buildManifest.targets, [
      { target: 'darwin-arm64', manifest: 'darwin-arm64/manifest.json' }
    ])
    assert.deepEqual(
      targetManifest.files.map(({ name, role, variant }) => ({ name, role, variant })),
      [
        { name: 'phi-kernel', role: 'kernel', variant: undefined },
        {
          name: 'pi_natives.darwin-arm64.node',
          role: 'native',
          variant: undefined
        }
      ]
    )
    for (const file of targetManifest.files) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/)
      assert.ok(file.size > 0)
    }

    const layout = prepareRuntime('legacy', 'http://127.0.0.1:9/v1')
    mkdirSync(path.join(layout.agentDir, 'extensions'), { recursive: true })
    writeFileSync(
      path.join(layout.agentDir, 'extensions', 'legacy-root.ts'),
      `import { SessionManager } from '@oh-my-pi/pi-coding-agent';
import { writeFileSync } from 'node:fs';
if (typeof SessionManager.inMemory !== 'function') throw new Error('legacy coding-agent root is incomplete');
writeFileSync(process.env.PHI_LEGACY_PROBE_PATH, 'resolved');
export default function legacyRootProbe() {}
`
    )
    const kernel = launchCompiled(layout)
    try {
      const greeting = await withTimeout(
        kernel.client.hello({
          hostCapabilities: ['settings.nextActionSuggestionsEnabled', 'skills.scriptTools']
        }),
        'compiled hello timed out'
      )
      assert.deepEqual(greeting.kernel, {
        version: packageVersion(path.join(repoRoot, 'package.json')),
        ompVersion: packageVersion(
          path.join(repoRoot, 'node_modules/@oh-my-pi/pi-coding-agent/package.json')
        )
      })
      const sessionId = await withTimeout(
        createSession(kernel.client, layout, false),
        'compiled legacy session creation timed out',
        20_000
      )
      assert.equal(readFileSync(layout.legacyProbe, 'utf8'), 'resolved')
      await kernel.client.request('session.close', {}, { sessionId })
      assert.equal(existsSync(path.join(layout.home, '.omp', 'natives')), false)
    } finally {
      await kernel.close()
    }
    assert.equal(kernel.process.exitCode, 0)
    assert.equal(kernel.diagnostics.join(''), '')
  }
)

test(
  'compiled kernel hosts the brokers and workers OMP starts by re-entering it',
  {
    timeout: 90_000,
    skip: process.platform !== 'darwin' || process.arch !== 'arm64'
  },
  async () => {
    const provider = await startLoopbackModel()
    const layout = prepareRuntime('workers', provider.url)
    provider.enqueue(
      { tool: { name: 'write', id: 'broker', args: { path: 'proc://missing-job', content: '' } } },
      {
        tool: {
          name: 'eval',
          id: 'js-worker',
          args: { language: 'js', title: 'Worker', code: 'console.log("COMPILED_JS_" + 6 * 7)' }
        }
      },
      { text: 'COMPILED_WORKERS_COMPLETE' }
    )
    const kernel = launchCompiled(layout)
    const completed = Promise.withResolvers<Record<string, JsonValue>>()
    const stopEvents = kernel.client.onEvent((event: KernelEventFrame) => {
      if (event.type === 'run.completed') completed.resolve(record(event.payload))
    })
    try {
      await withTimeout(
        kernel.client.hello({
          hostCapabilities: ['settings.nextActionSuggestionsEnabled', 'skills.scriptTools']
        }),
        'compiled hello timed out'
      )
      await kernel.client.subscribe(0)
      const sessionId = await withTimeout(
        createSession(kernel.client, layout, true),
        'compiled worker session creation timed out',
        20_000
      )
      await kernel.client.request('session.prompt', { text: 'Run the tools.' }, { sessionId })
      const completion = await withTimeout(completed.promise, 'compiled turn timed out', 60_000)
      assert.equal(completion.status, 'completed')
      const transcript = JSON.stringify(
        await kernel.client.request('session.snapshot', {}, { sessionId })
      )
      assert.doesNotMatch(transcript, /Failed to start daemon broker/)
      assert.match(transcript, /missing-job/)
      assert.match(transcript, /COMPILED_JS_42/)
      await kernel.client.request('session.close', {}, { sessionId })
    } finally {
      stopEvents()
      await kernel.close()
      await provider.close()
    }
    assert.equal(kernel.process.exitCode, 0)
  }
)

test(
  'relocated darwin kernel runs a scripted native grep turn without extracting an addon',
  {
    timeout: 60_000,
    skip: process.platform !== 'darwin' || process.arch !== 'arm64'
  },
  async () => {
    const provider = await startLoopbackModel()
    const layout = prepareRuntime('native-turn', provider.url)
    writeFileSync(path.join(layout.project, 'evidence.txt'), 'COMPILED_NATIVE_GREP_EVIDENCE\n')
    provider.enqueue(
      {
        tool: {
          name: 'grep',
          id: 'compiled-native-grep',
          args: { pattern: 'COMPILED_NATIVE_GREP_EVIDENCE', path: 'evidence.txt' }
        }
      },
      { text: 'COMPILED_NATIVE_TURN_COMPLETE' }
    )
    const kernel = launchCompiled(layout)
    const completions = new Map<string, Record<string, JsonValue>>()
    const waiters = new Map<string, (payload: Record<string, JsonValue>) => void>()
    const stopEvents = kernel.client.onEvent((event: KernelEventFrame) => {
      if (event.type !== 'run.completed') return
      const payload = record(event.payload)
      if (typeof payload.runId !== 'string') return
      completions.set(payload.runId, payload)
      waiters.get(payload.runId)?.(payload)
      waiters.delete(payload.runId)
    })
    const waitForRun = (runId: string): Promise<Record<string, JsonValue>> => {
      const completed = completions.get(runId)
      if (completed) return Promise.resolve(completed)
      return new Promise((resolveRun) => waiters.set(runId, resolveRun))
    }

    try {
      await withTimeout(
        kernel.client.hello({
          hostCapabilities: ['settings.nextActionSuggestionsEnabled', 'skills.scriptTools']
        }),
        'compiled hello timed out'
      )
      await kernel.client.subscribe(0)
      const sessionId = await withTimeout(
        createSession(kernel.client, layout, true),
        'compiled native session creation timed out',
        20_000
      )
      const started = record(
        await kernel.client.request(
          'session.prompt',
          { text: 'Use grep to find the evidence marker.' },
          { sessionId }
        )
      )
      assert.equal(typeof started.runId, 'string')
      const completion = await withTimeout(
        waitForRun(started.runId as string),
        'compiled native turn timed out',
        30_000
      )
      assert.equal(completion.status, 'completed')
      const snapshot = await kernel.client.request('session.snapshot', {}, { sessionId })
      const serialized = JSON.stringify(snapshot)
      assert.match(serialized, /COMPILED_NATIVE_GREP_EVIDENCE/)
      assert.match(serialized, /COMPILED_NATIVE_TURN_COMPLETE/)
      assert.match(JSON.stringify(provider.requests), /COMPILED_NATIVE_GREP_EVIDENCE/)
      assert.equal(existsSync(path.join(layout.home, '.omp', 'natives')), false)
      await kernel.client.request('session.close', {}, { sessionId })
    } finally {
      stopEvents()
      await kernel.close()
      await provider.close()
    }
    assert.equal(kernel.process.exitCode, 0)
    assert.equal(kernel.diagnostics.join(''), '')
  }
)
