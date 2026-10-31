import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { KernelProtocolCore, type FrameTransport } from '../src/kernel/protocol'
import {
  RemoteKernelError,
  assertRemoteKernelRuntimeIdentity,
  buildRemoteKernelLaunchCommand,
  ensureRemoteKernelDeployment,
  launchRemoteKernel,
  reattachRemoteKernel,
  remoteKernelHostFromSshSession,
  type KernelBuildManifest,
  type LaunchRemoteKernelOptions,
  type RemoteKernelDeploymentHost,
  type RemoteKernelDeploymentProgress,
  type RemoteKernelVariant
} from '../src/main/agent/engine/kernel-client/remote'
import type { TransferEvent } from '../src/main/agent/transfer'
import {
  GLIBC_MINIMUM_CHECK,
  linkPreviousNativeCommand,
  remoteKernelPaths
} from '../src/main/agent/engine/kernel-client/remote/commands'
import { shellQuote, type RemoteStdioProcess } from '../src/main/agent/wrappers/remote-ssh-session'

test('attached kernel identity rejects a stale HOME or agentDir', () => {
  const greeting = {
    protocol: { major: 1, minor: 0 },
    kernel: { version: '0.1.0', ompVersion: '18.10.3' },
    kernelInstanceId: 'stale-kernel',
    controllerGeneration: 1,
    capabilities: [],
    lastSeq: 0,
    runtime: { home: '/old/home', agentDir: '/old/agent' }
  }
  assert.throws(
    () =>
      assertRemoteKernelRuntimeIdentity(greeting, {
        home: '/expected/home',
        agentDir: '/expected/agent'
      }),
    (error: unknown) =>
      error instanceof RemoteKernelError &&
      error.code === 'LAUNCH_FAILED' &&
      /HOME or agent directory/u.test(error.message)
  )
})
import {
  remoteHelperReadyMarkerSha256,
  type RemoteHelperInstallation
} from '../src/main/agent/remote-helper-marker'
import type { CommandResult, HostCapabilityProfile } from '../src/main/agent/workspace-host/types'
import {
  FAST_PROBE_END_SENTINEL,
  FAST_PROBE_START_SENTINEL
} from '../src/main/agent/workspace-host/probe-script'

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')

const helperMarker = {
  schema: 1,
  kind: 'remote-helper',
  version: '0.4.0',
  sha256: 'b'.repeat(64)
} as const

const helperInstallation: RemoteHelperInstallation = {
  managedRoot: '/srv/phi-helper',
  remotePath: '/srv/phi-helper/0.4.0/phi-helper',
  remoteDirectory: '/srv/phi-helper/0.4.0',
  readyMarkerPath: '/srv/phi-helper/0.4.0/.phi-ready.json',
  markerIdentity: helperMarker,
  readyMarkerSha256: remoteHelperReadyMarkerSha256(helperMarker)
}

async function createBuildFixture(): Promise<{
  directory: string
  manifest: KernelBuildManifest
  cleanup(): Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'phi-kernel-remote-build-'))
  const contents = {
    'phi-kernel': '#!/bin/sh\nprintf kernel\n',
    'pi_natives.linux-x64-modern.node': 'modern native bytes\n',
    'pi_natives.linux-x64-baseline.node': 'baseline native bytes\n'
  }
  for (const [name, content] of Object.entries(contents))
    await writeFile(join(directory, name), content)
  const manifest: KernelBuildManifest = {
    phiVersion: '0.1.0',
    ompVersion: '18.10.3',
    nativeVersion: '18.10.3',
    bunVersion: '1.3.3',
    target: 'linux-x64',
    files: [
      {
        name: 'phi-kernel',
        role: 'kernel',
        sha256: sha256(contents['phi-kernel']),
        size: Buffer.byteLength(contents['phi-kernel'])
      },
      {
        name: 'pi_natives.linux-x64-modern.node',
        role: 'native',
        variant: 'modern',
        sha256: sha256(contents['pi_natives.linux-x64-modern.node']),
        size: Buffer.byteLength(contents['pi_natives.linux-x64-modern.node'])
      },
      {
        name: 'pi_natives.linux-x64-baseline.node',
        role: 'native',
        variant: 'baseline',
        sha256: sha256(contents['pi_natives.linux-x64-baseline.node']),
        size: Buffer.byteLength(contents['pi_natives.linux-x64-baseline.node'])
      }
    ]
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  return { directory, manifest, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

function profile(
  overrides: Partial<HostCapabilityProfile['platform']> = {}
): HostCapabilityProfile {
  return {
    platform: {
      os: 'Linux',
      arch: 'x86_64',
      libc: { name: 'glibc', version: '2.17' },
      ...overrides
    },
    probedAt: '2026-01-01T00:00:00.000Z',
    fs: { state: 'available' },
    exec: { state: 'available' },
    background: { state: 'available' },
    pty: { state: 'available' },
    watch: { state: 'unavailable' },
    forwardPort: { state: 'available' },
    toolchain: {
      git: { state: 'available' },
      nextflow: { state: 'unavailable' },
      java: { state: 'unavailable' },
      conda: { state: 'unavailable' },
      sbatch: { state: 'unavailable' },
      containerRuntime: { state: 'unavailable' },
      module: { state: 'unavailable' }
    }
  }
}

type Upload = {
  localPath: string
  remotePath: string
  expectedSha256?: string
  maxAttempts?: number
  retryBackoffMs?: number
  transferId?: string
}

class FakeDeploymentHost implements RemoteKernelDeploymentHost {
  readonly commands: string[] = []
  readonly uploads: Upload[] = []
  variant: RemoteKernelVariant = 'modern'
  markerVariant?: RemoteKernelVariant
  remotePlatformFailure?: string
  activationHashMismatch = false
  uploadHashMismatch = false
  uploadFailureCode?: string
  nativeLinkFails = false
  helper: RemoteHelperInstallation | undefined = helperInstallation
  repairedHelper: RemoteHelperInstallation | undefined = helperInstallation
  readonly helperEnsureCalls: Array<{ force?: boolean } | undefined> = []

  readonly exec = {
    run: async (command: readonly string[]): Promise<CommandResult> => {
      const script = command[2] ?? ''
      this.commands.push(script)
      if (script.includes('for candidate in') && this.nativeLinkFails) {
        return { stdout: '', stderr: 'denied', code: 1, signal: null, truncated: false }
      }
      if (script.includes('remote_os=$(uname')) {
        if (this.remotePlatformFailure) {
          return {
            stdout: '',
            stderr: `PHI_KERNEL:UNSUPPORTED_PLATFORM:${this.remotePlatformFailure}\n`,
            code: 1,
            signal: null,
            truncated: false
          }
        }
        const state =
          this.markerVariant === this.variant ? 'PHI_KERNEL_REUSABLE' : 'PHI_KERNEL_DEPLOY'
        return {
          stdout: `PHI_KERNEL_PROFILE:linux:x64:glibc:2.17:${this.variant}\n${state}\n`,
          stderr: '',
          code: 0,
          signal: null,
          truncated: false
        }
      }
      if (script.includes('actual_kernel=$(hash_file')) {
        if (this.activationHashMismatch) {
          this.markerVariant = undefined
          return {
            stdout: '',
            stderr: 'PHI_KERNEL:HASH_MISMATCH:Uploaded kernel SHA256 does not match its manifest\n',
            code: 1,
            signal: null,
            truncated: false
          }
        }
        this.markerVariant = this.variant
      } else if (script.startsWith('rm -f --')) {
        this.markerVariant = undefined
      }
      return { stdout: '', stderr: '', code: 0, signal: null, truncated: false }
    }
  }

  readonly transfer = {
    uploadFile: async (
      localPath: string,
      remotePath: string,
      options?: {
        expectedSha256?: string
        maxAttempts?: number
        retryBackoffMs?: number
        transferId?: string
        onEvent?: (event: TransferEvent) => void
      }
    ): Promise<void> => {
      if (this.uploadHashMismatch || this.uploadFailureCode) {
        throw Object.assign(new Error('Transfer rejected uploaded bytes.'), {
          code: this.uploadFailureCode ?? 'HASH_MISMATCH'
        })
      }
      this.uploads.push({
        localPath,
        remotePath,
        expectedSha256: options?.expectedSha256,
        maxAttempts: options?.maxAttempts,
        retryBackoffMs: options?.retryBackoffMs,
        transferId: options?.transferId
      })
      const size = (await stat(localPath)).size
      for (const bytesTransferred of [Math.floor(size / 2), size]) {
        options?.onEvent?.({
          transferId: options.transferId ?? 'kernel-test-transfer',
          direction: 'upload',
          state: bytesTransferred === size ? 'saved' : 'transferring',
          bytesTransferred,
          totalBytes: size,
          resumedFrom: 0,
          instantaneousBytesPerSecond: 1,
          smoothedBytesPerSecond: 1
        })
      }
    }
  }

  constructor(private readonly capabilityProfile = profile()) {}

  capabilities(): HostCapabilityProfile {
    return this.capabilityProfile
  }

  managedRemoteHelper(): RemoteHelperInstallation | undefined {
    return this.helper
  }

  async ensureManagedRemoteHelper(options?: {
    force?: boolean
  }): Promise<RemoteHelperInstallation | undefined> {
    this.helperEnsureCalls.push(options)
    if (options?.force) this.helper = this.repairedHelper
    return this.helper
  }
}

test('deploys only the selected modern native, validates hashes, and publishes the marker last', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  const host = new FakeDeploymentHost()
  const runtimeRoot = "/srv/phi user's runtime"
  const result = await ensureRemoteKernelDeployment({
    runtimeHost: host,
    runtimeRoot,
    buildDirectory: fixture.directory,
    uploadOptions: { hostKey: 'modern-host' }
  })

  assert.equal(result.reused, false)
  assert.equal(result.variant, 'modern')
  assert.equal(result.profile.glibcVersion, '2.17')
  assert.equal(result.remoteCommandCount, 3)
  assert.equal(
    result.executablePath,
    `${runtimeRoot}/kernel/0.1.0/${fixture.manifest.files[0].sha256}/phi-kernel`
  )
  assert.equal(host.uploads.length, 2)
  assert.match(host.uploads[0].remotePath, /\.phi-kernel\.[a-f0-9]{64}\.staging$/)
  assert.match(host.uploads[1].remotePath, /modern\.node\.[a-f0-9]{64}\.staging$/)
  assert.equal(
    host.uploads.some((upload) => upload.remotePath.includes('baseline')),
    false
  )
  for (const upload of host.uploads) assert.match(upload.expectedSha256 ?? '', /^[a-f0-9]{64}$/)
  for (const upload of host.uploads) {
    assert.equal(upload.maxAttempts, 3)
    assert.equal(upload.retryBackoffMs, 1_000)
  }
  for (const command of host.commands) {
    const syntax = spawnSync('/bin/sh', ['-n'], { input: command, encoding: 'utf8' })
    assert.equal(syntax.status, 0, syntax.stderr)
  }

  assert.match(host.commands[0], /grep -Eiq .*avx2.*\/proc\/cpuinfo/)
  assert.ok(host.commands[0].includes("[ \"$(pwd -P)\" = '/srv/phi user'\\''s runtime' ]"))
  const activate = host.commands[2]
  assert.ok(activate.indexOf('actual_kernel=') < activate.indexOf('mv -f --'))
  assert.ok(activate.lastIndexOf('mv -f --') < activate.lastIndexOf('.phi-ready.json'))
})

test('a failed native link still uploads the addon', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  const host = new FakeDeploymentHost()
  host.nativeLinkFails = true

  const result = await ensureRemoteKernelDeployment({
    runtimeHost: host,
    runtimeRoot: '/srv/phi-runtime',
    buildDirectory: fixture.directory
  })

  assert.equal(result.reused, false)
  assert.equal(host.uploads.length, 2)
  assert.ok(host.commands[1].includes('for candidate in'))
})

test('a new kernel build links an unchanged native from an earlier build', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi kernel-link-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const content = Buffer.from('native addon bytes')
  const native = {
    name: 'pi_natives.linux-x64-modern.node',
    role: 'native' as const,
    variant: 'modern' as const,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.length
  }
  const kernel = { name: 'phi-kernel', role: 'kernel' as const, sha256: 'b'.repeat(64), size: 1 }
  const paths = remoteKernelPaths(root, '0.1.0', kernel, {
    modern: native,
    baseline: { ...native, name: 'baseline.node', variant: 'baseline' }
  })
  const staging = paths.stagingNativeByVariant.modern
  const run = (): void => {
    const done = spawnSync('/bin/sh', ['-c', linkPreviousNativeCommand(paths, native, 'modern')], {
      cwd: root,
      encoding: 'utf8'
    })
    assert.equal(done.status, 0, done.stderr)
  }
  const earlier = (build: string): string => join(root, 'kernel', '0.1.0', build, native.name)
  await mkdir(paths.directory, { recursive: true })

  run()
  assert.equal(existsSync(staging), false, 'no earlier build: nothing to link')

  for (const build of ['same-size-other-bytes', 'other-size', 'symlink', 'match']) {
    await mkdir(join(root, 'kernel', '0.1.0', build), { recursive: true })
  }
  await writeFile(earlier('same-size-other-bytes'), Buffer.alloc(content.length, 1))
  await writeFile(earlier('other-size'), 'short')
  await writeFile(join(root, 'target'), content)
  await symlink(join(root, 'target'), earlier('symlink'))
  run()
  assert.equal(existsSync(staging), false, 'only a regular file with the same bytes qualifies')

  await writeFile(earlier('match'), content)
  run()
  assert.equal((await stat(staging)).ino, (await stat(earlier('match'))).ino)

  run()
  assert.equal((await stat(staging)).ino, (await stat(earlier('match'))).ino)
})

test('kernel deployment reports aggregate acknowledged bytes across both uploaded files', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  const host = new FakeDeploymentHost()
  const progress: RemoteKernelDeploymentProgress[] = []

  await ensureRemoteKernelDeployment({
    runtimeHost: host,
    runtimeRoot: '/srv/phi-runtime',
    buildDirectory: fixture.directory,
    uploadOptions: { hostKey: 'progress-host' },
    onProgress: (event) => progress.push(event)
  })

  const totalBytes = fixture.manifest.files[0].size + fixture.manifest.files[1].size
  const uploading = progress.filter((event) => event.phase === 'uploading')
  assert.ok(uploading.length >= 4)
  assert.ok(uploading.some((event) => event.bytesTransferred === fixture.manifest.files[0].size))
  assert.ok(uploading.some((event) => event.bytesTransferred === totalBytes))
  assert.ok(uploading.every((event) => event.totalBytes === totalBytes))
})

test('prepared deployment is reused in one command without local rehash or upload', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  const host = new FakeDeploymentHost()
  host.markerVariant = 'baseline'
  host.variant = 'baseline'

  const first = await ensureRemoteKernelDeployment({
    runtimeHost: host,
    runtimeRoot: '/srv/phi-runtime',
    buildDirectory: fixture.directory
  })
  assert.equal(first.reused, true)
  assert.equal(first.remoteCommandCount, 1)
  assert.equal(host.uploads.length, 0)

  await rm(join(fixture.directory, 'phi-kernel'))
  const second = await ensureRemoteKernelDeployment({
    runtimeHost: host,
    runtimeRoot: '/srv/phi-runtime',
    buildDirectory: fixture.directory
  })
  assert.equal(second.reused, true)
  assert.equal(second.remoteCommandCount, 1)
  assert.equal(host.commands.length, 2)
})

test('CPU variant changes invalidate the marker and redeploy only the new native', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  const host = new FakeDeploymentHost()
  await ensureRemoteKernelDeployment({
    runtimeHost: host,
    runtimeRoot: '/srv/phi-runtime',
    buildDirectory: fixture.directory
  })
  host.variant = 'baseline'

  const moved = await ensureRemoteKernelDeployment({
    runtimeHost: host,
    runtimeRoot: '/srv/phi-runtime',
    buildDirectory: fixture.directory
  })
  assert.equal(moved.reused, false)
  assert.equal(moved.variant, 'baseline')
  assert.match(host.uploads.at(-1)?.remotePath ?? '', /baseline/)
  assert.equal(host.uploads.length, 4)
})

test('capability and live-probe platform failures are typed and never upload', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  for (const platform of [
    { os: 'darwin' },
    { arch: 'aarch64' },
    { libc: { name: 'musl' as const } }
  ]) {
    const host = new FakeDeploymentHost(profile(platform))
    await assert.rejects(
      ensureRemoteKernelDeployment({
        runtimeHost: host,
        runtimeRoot: '/srv/phi-runtime',
        buildDirectory: fixture.directory
      }),
      { name: 'RemoteKernelError', code: 'UNSUPPORTED_PLATFORM' }
    )
    assert.equal(host.commands.length, 0)
    assert.equal(host.uploads.length, 0)
  }

  const stale = new FakeDeploymentHost()
  stale.remotePlatformFailure = 'detected Linux/aarch64'
  await assert.rejects(
    ensureRemoteKernelDeployment({
      runtimeHost: stale,
      runtimeRoot: '/srv/phi-runtime',
      buildDirectory: fixture.directory
    }),
    { name: 'RemoteKernelError', code: 'UNSUPPORTED_PLATFORM' }
  )
  assert.equal(stale.commands.length, 1)
  assert.equal(stale.uploads.length, 0)
})

test('remote activation hash mismatch is typed, clears staging, and never publishes ready state', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  const host = new FakeDeploymentHost()
  host.activationHashMismatch = true
  await assert.rejects(
    ensureRemoteKernelDeployment({
      runtimeHost: host,
      runtimeRoot: '/srv/phi-runtime',
      buildDirectory: fixture.directory
    }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteKernelError)
      assert.equal(error.code, 'HASH_MISMATCH')
      return true
    }
  )
  assert.equal(host.markerVariant, undefined)
  assert.equal(host.commands.length, 4)
  assert.match(host.commands.at(-1) ?? '', /^rm -f --/)
  assert.equal(host.commands.at(-1)?.includes('.phi-ready.json'), true)
})

test('streaming upload hash mismatch is typed and never publishes a ready marker', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  const host = new FakeDeploymentHost()
  host.uploadHashMismatch = true
  await assert.rejects(
    ensureRemoteKernelDeployment({
      runtimeHost: host,
      runtimeRoot: '/srv/phi-runtime',
      buildDirectory: fixture.directory
    }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteKernelError)
      assert.equal(error.code, 'HASH_MISMATCH')
      return true
    }
  )
  assert.equal(host.markerVariant, undefined)
  assert.equal(host.commands.length, 3)
  assert.match(host.commands.at(-1) ?? '', /^rm -f --/)
  assert.equal(host.commands.at(-1)?.includes('.phi-ready.json'), true)
})

test('exhausted upload stalls stay machine-readable and never publish a ready marker', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  const host = new FakeDeploymentHost()
  host.uploadFailureCode = 'TRANSFER_STALLED'
  const progress: RemoteKernelDeploymentProgress[] = []
  await assert.rejects(
    ensureRemoteKernelDeployment({
      runtimeHost: host,
      runtimeRoot: '/srv/phi-runtime',
      buildDirectory: fixture.directory,
      onProgress: (event) => progress.push(event)
    }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteKernelError)
      assert.equal(error.code, 'TRANSFER_STALLED')
      assert.equal(error.errorCode, 'REMOTE_KERNEL_UPLOAD_FAILED')
      return true
    }
  )
  assert.equal(host.markerVariant, undefined)
  assert.match(host.commands.at(-1) ?? '', /^rm -f --/)
  assert.equal(progress.at(-1)?.phase, 'failed')
})

class LoopbackKernelProcess implements RemoteStdioProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly closed: Promise<{ code: number | null; signal: string | null }>
  private finish!: () => void
  private done = false

  constructor(
    core = new KernelProtocolCore({
      kernelVersion: 'test-kernel',
      ompVersion: '18.10.3',
      kernelInstanceId: 'remote-test-kernel'
    })
  ) {
    this.closed = new Promise((resolve) => {
      this.finish = () => resolve({ code: 0, signal: null })
    })
    const lines = createInterface({ input: this.stdin, crlfDelay: Infinity })
    const lineListeners = new Set<(line: string) => void>()
    const closeListeners = new Set<() => void>()
    const transport: FrameTransport = {
      send: (line) => this.stdout.write(line),
      onLine: (listener) => lineListeners.add(listener),
      onClose: (listener) => closeListeners.add(listener)
    }
    lines.on('line', (line) => {
      for (const listener of lineListeners) listener(line)
    })
    lines.once('close', () => {
      for (const listener of closeListeners) listener()
      this.complete()
    })
    core.attachTransport(transport, { trusted: true })
  }

  async close(): Promise<void> {
    this.stdin.end()
    await this.closed
  }

  writeDiagnostic(text: string): void {
    this.stderr.write(text)
  }

  private complete(): void {
    if (this.done) return
    this.done = true
    this.stdout.end()
    this.stderr.end()
    this.finish()
  }
}

test('remote launcher negotiates over SSH stdio with explicit isolated env and connection lifetime', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  const host = new FakeDeploymentHost()
  host.markerVariant = 'modern'
  const commands: string[] = []
  let process: LoopbackKernelProcess | undefined
  const session: LaunchRemoteKernelOptions['session'] = {
    remoteHelper: helperInstallation,
    async exec() {
      return { stdout: '', stderr: '', code: 0, signal: null }
    },
    async uploadFile() {
      return undefined
    },
    async openStdio(command) {
      commands.push(command)
      process = new LoopbackKernelProcess()
      queueMicrotask(() =>
        process?.writeDiagnostic(
          'PHI_HELPER_ATTACH_STATUS={"state":"spawned","pid":123}\nkernel diagnostic\n'
        )
      )
      return process
    }
  }
  const diagnostics: string[] = []
  const progress: RemoteKernelDeploymentProgress[] = []
  const launched = await launchRemoteKernel({
    session,
    runtimeHost: host,
    runtimeRoot: "/srv/phi user's runtime",
    buildDirectory: fixture.directory,
    home: '/srv/phi test/home',
    agentDir: '/srv/phi test/agent',
    environment: { NO_PROXY: '127.0.0.1,localhost' },
    onDiagnostic: (text) => diagnostics.push(text),
    onProgress: (event) => progress.push(event)
  })

  assert.equal(launched.client.controllerGeneration, 1)
  assert.deepEqual(launched.attach, { state: 'spawned', pid: 123 })
  assert.equal(launched.deployment.reused, true)
  assert.equal(launched.remoteCommandCount, 2)
  assert.equal(launched.homePath, '/srv/phi test/home')
  assert.equal(launched.agentDir, '/srv/phi test/agent')
  assert.equal(commands.length, 1)
  assert.deepEqual(
    progress.map((event) => event.phase),
    ['checking', 'ready']
  )
  assert.match(commands[0], /^umask 077 && cd -- '\/srv\/phi test\/home' && exec env -i /)
  assert.ok(commands[0].includes("'/srv/phi-helper/0.4.0/phi-helper' attach"))
  assert.ok(
    commands[0].includes(
      `--kernel-version '0.1.0+${launched.deployment.kernelSha256.slice(0, 12)}+${createHash(
        'sha256'
      )
        .update('/srv/phi test/home')
        .update('\0')
        .update('/srv/phi test/agent')
        .digest('hex')
        .slice(0, 12)}'`
    ),
    'socket identity binds both the build and requested HOME/agentDir'
  )
  assert.ok(commands[0].includes("--env 'HOME=/srv/phi test/home'"))
  assert.ok(commands[0].includes("--env 'PI_CODING_AGENT_DIR=/srv/phi test/agent'"))
  assert.ok(commands[0].includes("--env 'NO_PROXY=127.0.0.1,localhost'"))
  assert.equal(commands[0].includes('PI_NATIVES_DIR'), false)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(diagnostics, ['kernel diagnostic\n'])

  await launched.close()
  assert.ok(process)
  await process.closed
})

test('remote launcher repairs a stale marker-backed helper through the existing installer surface', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  const host = new FakeDeploymentHost()
  host.markerVariant = 'modern'
  host.helper = {
    ...helperInstallation,
    remotePath: '/srv/phi-helper/0.3.0/phi-helper',
    remoteDirectory: '/srv/phi-helper/0.3.0',
    readyMarkerPath: '/srv/phi-helper/0.3.0/.phi-ready.json',
    markerIdentity: { ...helperInstallation.markerIdentity, version: '0.3.0' }
  }
  let process: LoopbackKernelProcess | undefined
  const launched = await launchRemoteKernel({
    session: {
      async exec() {
        return { stdout: '', stderr: '', code: 0, signal: null }
      },
      async uploadFile() {
        return undefined
      },
      async openStdio() {
        process = new LoopbackKernelProcess()
        queueMicrotask(() =>
          process?.writeDiagnostic('PHI_HELPER_ATTACH_STATUS={"state":"spawned","pid":987}\n')
        )
        return process
      }
    },
    runtimeHost: host,
    runtimeRoot: '/srv/phi-runtime',
    buildDirectory: fixture.directory
  })

  assert.deepEqual(host.helperEnsureCalls, [undefined, { force: true }])
  assert.equal(launched.helper.markerIdentity.version, '0.4.0')
  await launched.close()
})

test('remote launcher never falls back to executing the kernel without a helper marker', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  const host = new FakeDeploymentHost()
  host.markerVariant = 'modern'
  host.helper = undefined
  host.repairedHelper = undefined
  let opens = 0

  await assert.rejects(
    launchRemoteKernel({
      session: {
        async exec() {
          return { stdout: '', stderr: '', code: 0, signal: null }
        },
        async uploadFile() {
          return undefined
        },
        async openStdio() {
          opens++
          return new LoopbackKernelProcess()
        }
      },
      runtimeHost: host,
      runtimeRoot: '/srv/phi-runtime',
      buildDirectory: fixture.directory
    }),
    { name: 'RemoteKernelError', code: 'HELPER_UNAVAILABLE' }
  )
  assert.equal(opens, 0)
})

test('session-only prepared launch probes capabilities and stays at three remote commands', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  let controlCommands = 0
  let process: LoopbackKernelProcess | undefined
  const session: LaunchRemoteKernelOptions['session'] = {
    remoteHelper: helperInstallation,
    async exec() {
      throw new Error('bounded/input transports should be used')
    },
    async execWithInput(command, input) {
      controlCommands++
      assert.equal(command, 'sh -s')
      assert.match(input, /platform\.os/)
      return {
        stdout: `${FAST_PROBE_START_SENTINEL}\nplatform.os=Linux\nplatform.arch=x86_64\nlibc.name=glibc\nlibc.version=2.17\nprobe.fast_complete=1\n${FAST_PROBE_END_SENTINEL}\n`,
        stderr: '',
        code: 0,
        signal: null
      }
    },
    async execBounded(command) {
      controlCommands++
      assert.match(command, /remote_os=\$\(uname/)
      return {
        stdout: 'PHI_KERNEL_PROFILE:linux:x64:glibc:2.17:modern\nPHI_KERNEL_REUSABLE\n',
        stderr: '',
        code: 0,
        signal: null,
        stdoutTruncated: false,
        stderrTruncated: false
      }
    },
    async uploadFile() {
      throw new Error('prepared host must not upload')
    },
    async openStdio() {
      controlCommands++
      process = new LoopbackKernelProcess()
      queueMicrotask(() =>
        process?.writeDiagnostic('PHI_HELPER_ATTACH_STATUS={"state":"attached"}\n')
      )
      return process
    }
  }

  const launched = await launchRemoteKernel({
    session,
    runtimeRoot: '/srv/phi-runtime',
    buildDirectory: fixture.directory
  })
  assert.equal(launched.deployment.reused, true)
  assert.equal(launched.remoteCommandCount, 3)
  assert.equal(controlCommands, 3)
  await launched.close()
  assert.ok(process)
})

test('reattach takes over, replays available events, and reports replay gaps', async (t) => {
  const fixture = await createBuildFixture()
  t.after(fixture.cleanup)
  const host = new FakeDeploymentHost()
  host.markerVariant = 'modern'
  const configurations: unknown[] = []
  const model = {
    provider: 'fixture',
    id: 'fixture-model',
    name: 'Fixture model',
    reasoning: false,
    input: ['text'] as Array<'text' | 'image'>,
    contextWindow: 32_000,
    maxTokens: 4_000
  }
  const core = new KernelProtocolCore({
    kernelVersion: 'test-kernel',
    ompVersion: '18.10.3',
    kernelInstanceId: 'stable-remote-kernel',
    replayCapacity: 1,
    handlers: {
      'events.subscribe': () => ({ subscribed: true, lastSeq: 0 }),
      'modelAccess.configure': (params) => {
        configurations.push(params)
        return { configured: true }
      }
    }
  })
  let opens = 0
  const session = (): LaunchRemoteKernelOptions['session'] => ({
    remoteHelper: helperInstallation,
    async exec() {
      return { stdout: '', stderr: '', code: 0, signal: null }
    },
    async uploadFile() {
      return undefined
    },
    async openStdio() {
      opens++
      const process = new LoopbackKernelProcess(core)
      queueMicrotask(() =>
        process.writeDiagnostic(
          `PHI_HELPER_ATTACH_STATUS={"state":"${opens === 1 ? 'spawned' : 'attached'}"${
            opens === 1 ? ',"pid":321' : ''
          }}\n`
        )
      )
      return process
    }
  })

  const launched = await launchRemoteKernel({
    session: session(),
    runtimeHost: host,
    runtimeRoot: '/srv/phi-runtime',
    buildDirectory: fixture.directory,
    modelAccess: {
      endpoint: 'http://127.0.0.1:43123/v1/pi/stream',
      bearerToken: 'a'.repeat(43),
      models: [model]
    }
  })
  core.emitEvent('test.event', { index: 1 })
  core.emitEvent('test.event', { index: 2 })

  const reattached = await reattachRemoteKernel({
    session: session(),
    previous: launched,
    lastSeen: 0,
    modelAccess: () => ({
      endpoint: 'http://127.0.0.1:43124/v1/pi/stream',
      bearerToken: 'b'.repeat(43),
      models: [model]
    })
  })

  assert.equal(reattached.greeting.kernelInstanceId, launched.greeting.kernelInstanceId)
  assert.equal(reattached.client.controllerGeneration, 2)
  assert.deepEqual(reattached.attach, { state: 'attached' })
  assert.equal(reattached.snapshotRequired, true)
  assert.equal(reattached.remoteCommandCount, 1)
  assert.equal(opens, 2)
  assert.deepEqual(
    configurations.map((value) => (value as { endpoint: string }).endpoint),
    ['http://127.0.0.1:43123/v1/pi/stream', 'http://127.0.0.1:43124/v1/pi/stream']
  )
  core.emitEvent('test.event', { index: 3 })
  const replayed: number[] = []
  const replayAttach = await reattachRemoteKernel({
    session: session(),
    previous: reattached,
    lastSeen: 2,
    onEvent: (event) => replayed.push(event.seq)
  })
  assert.equal(replayAttach.snapshotRequired, false)
  assert.deepEqual(replayed, [3])
  assert.equal(replayAttach.remoteCommandCount, 1)
  assert.equal(opens, 3)
  const replacementCore = new KernelProtocolCore({
    kernelVersion: 'test-kernel',
    ompVersion: '18.10.3',
    kernelInstanceId: 'replacement-remote-kernel',
    handlers: {
      'events.subscribe': () => ({ subscribed: true, lastSeq: 0 })
    }
  })
  const replacement = await reattachRemoteKernel({
    session: {
      async openStdio() {
        const process = new LoopbackKernelProcess(replacementCore)
        queueMicrotask(() =>
          process.writeDiagnostic('PHI_HELPER_ATTACH_STATUS={"state":"spawned","pid":654}\n')
        )
        return process
      }
    },
    previous: replayAttach,
    lastSeen: 3
  })
  assert.equal(replacement.greeting.kernelInstanceId, 'replacement-remote-kernel')
  assert.deepEqual(replacement.attach, { state: 'spawned', pid: 654 })
  assert.equal(replacement.snapshotRequired, true)
  await replacement.close()
  await replayAttach.close()
  await reattached.close()
  await launched.close()
})

test('SSH-session host adapter preserves cwd quoting and bounded command results', async () => {
  const commands: string[] = []
  const capabilityProfile = profile()
  const session = {
    async exec(command: string) {
      commands.push(command)
      return { stdout: 'fallback', stderr: '', code: 0, signal: null }
    },
    async execBounded(command: string) {
      commands.push(command)
      return {
        stdout: 'ok',
        stderr: '',
        code: 0,
        signal: null,
        stdoutTruncated: false,
        stderrTruncated: false
      }
    },
    async uploadFile() {
      return undefined
    }
  }
  const host = remoteKernelHostFromSshSession(session, capabilityProfile)
  const result = await host.exec.run(['sh', '-c', "printf '%s' ok"], {
    cwd: "/srv/user's root",
    maxOutputBytes: 100,
    timeoutMs: 1000
  })
  assert.equal(result.stdout, 'ok')
  assert.equal(commands.length, 1)
  assert.equal(commands[0], "cd -- '/srv/user'\\''s root' && sh -c 'printf '\\''%s'\\'' ok'")
})

test('glibc gate accepts 2.17 and newer and rejects older or unreadable versions', () => {
  const run = (version: string): { status: number | null; stderr: string } => {
    const script = `fail() { printf '%s %s\\n' "$1" "$2" >&2; exit 3; }
glibc_version=${shellQuote(version)}
${GLIBC_MINIMUM_CHECK}
printf ok`
    const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' })
    return { status: result.status, stderr: result.stderr }
  }
  for (const version of ['2.17', '2.28', '2.35', '3.0'])
    assert.equal(run(version).status, 0, version)
  for (const version of ['2.16', '2.5', '1.99', 'unknown', '']) {
    const result = run(version)
    assert.equal(result.status, 3, version)
    assert.match(result.stderr, /^UNSUPPORTED_PLATFORM /)
  }
})

test('launch command rejects PI_NATIVES_DIR injection', async () => {
  const deployment = {
    phiVersion: '0.1.0',
    kernelSha256: 'a'.repeat(64),
    runtimeRoot: '/srv/runtime',
    executablePath: '/srv/runtime/kernel/phi-kernel',
    nativePath: '/srv/runtime/kernel/native.node',
    homePath: '/srv/runtime/kernel-home',
    agentDir: '/srv/runtime/kernel-home/agent',
    profile: {
      os: 'linux' as const,
      arch: 'x64' as const,
      libc: 'glibc' as const,
      variant: 'baseline' as const
    },
    variant: 'baseline' as const,
    reused: true,
    remoteCommandCount: 1
  }
  assert.throws(
    () =>
      buildRemoteKernelLaunchCommand(deployment, helperInstallation, {
        PI_NATIVES_DIR: '/tmp/untrusted'
      }),
    { name: 'RemoteKernelError', code: 'INVALID_ARGUMENT' }
  )
})
