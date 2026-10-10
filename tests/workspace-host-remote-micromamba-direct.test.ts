import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it } from 'node:test'

import { ensureRemoteMicromamba } from '../src/main/agent/workspace-host/remote-micromamba'
import type { RemoteExecResult } from '../src/main/agent/wrappers/remote-ssh-session'
import type {
  RemoteMicromambaArtifact,
  RemoteMicromambaResult
} from '../src/shared/remoteMicromambaTypes'
import type { RemoteRuntimeRootCheckResult } from '../src/shared/remoteRuntimeRootTypes'
import { createLocalShellSession, type LocalShellSession } from './helpers/localShellSession'

const temporaryDirectories: string[] = []
const RELEASE_URL = 'https://micro.mamba.pm/api/micromamba/linux-64/2.9.0-0'

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), label))
  temporaryDirectories.push(path)
  return path
}

function runScript(command: string, input: string, path: string): Promise<RemoteExecResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      env: { ...process.env, PATH: path },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
    child.stdin.end(input)
  })
}

function localSession(bin: string, probeOverride?: string): LocalShellSession {
  const session = createLocalShellSession()
  session.execWithInput = (command, input) => {
    session.commands.push(command)
    if (probeOverride && input.includes('__PHI_MICROMAMBA_NETWORK__=')) {
      return Promise.resolve({ stdout: `${probeOverride}\n`, stderr: '', code: 0, signal: null })
    }
    return runScript(command, input, `${bin}:${process.env.PATH ?? ''}`)
  }
  return session
}

interface FakeDownloaderOptions {
  probeSucceeds: boolean
  downloadSucceeds: boolean
  source: string
  log: string
}

async function fakeDownloader(
  bin: string,
  name: 'curl' | 'wget',
  options: FakeDownloaderOptions
): Promise<void> {
  const path = join(bin, name)
  const probeExit = options.probeSucceeds ? 0 : 28
  const downloadExit = options.downloadSucceeds ? 0 : 23
  const script = `#!/bin/sh
printf '%s\n' "$*" >> '${options.log}'
phi_probe=0
phi_dest=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -I|--head|--spider|-fsSIL) phi_probe=1 ;;
    -o|--output|-O) shift; phi_dest=$1 ;;
  esac
  shift
done
[ "$phi_probe" = 0 ] || exit ${probeExit}
[ ${downloadExit} = 0 ] || exit ${downloadExit}
cp '${options.source}' "$phi_dest"
`
  await writeFile(path, script)
  await chmod(path, 0o755)
}

async function artifactFixture(): Promise<{
  plan: RemoteMicromambaArtifact & { url: string }
  relay: RemoteMicromambaArtifact
  remoteSource: string
}> {
  const dir = await temporaryDirectory('phi-remote-direct-artifact-')
  const remoteSource = join(dir, 'remote-micromamba')
  const relayPath = join(dir, 'relay-micromamba')
  const content = [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo 2.9.0; exit 0; fi',
    'if [ "$1" = "--rc-file" ]; then echo "platform : linux-64"; exit 0; fi',
    'exit 2',
    ''
  ].join('\n')
  await writeFile(remoteSource, content)
  await writeFile(relayPath, content)
  await chmod(remoteSource, 0o755)
  await chmod(relayPath, 0o755)
  const metadata = {
    version: '2.9.0-0',
    platform: 'linux-x64' as const,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content)
  }
  return {
    plan: { ...metadata, localPath: join(dir, 'desktop-cache-missing'), url: RELEASE_URL },
    relay: { ...metadata, localPath: relayPath },
    remoteSource
  }
}

function checkedRoot(root: string): RemoteRuntimeRootCheckResult {
  return {
    configured: root,
    checkedAt: '2026-10-10T00:00:00.000Z',
    status: 'checked',
    expandedPath: root,
    exists: false,
    nearestExistingAncestor: root,
    ancestorWritable: true,
    ownedByCurrentUser: true,
    groupOrOtherWritable: false,
    hasSymlink: false,
    fsType: 'ext4',
    availableKiB: 20_000_000,
    diskUsePercent: 20,
    inodeUsePercent: 10,
    executable: true,
    sharedFilesystem: false,
    computeNodeVisibility: 'unknown',
    hardErrors: [],
    warnings: []
  }
}

async function runInstall(input: {
  session: LocalShellSession
  root: string
  artifact: RemoteMicromambaArtifact & { url: string }
  obtainLocalArtifact: () => Promise<RemoteMicromambaArtifact>
  messages?: string[]
}): Promise<RemoteMicromambaResult> {
  return ensureRemoteMicromamba(input.session, {
    runtimeRoot: input.root,
    confirmedWarnings: [],
    artifact: input.artifact,
    obtainLocalArtifact: input.obtainLocalArtifact,
    checkRuntimeRoot: async () => checkedRoot(input.root),
    randomId: () => 'fixture',
    onProgress: ({ message }) => input.messages?.push(message)
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

it('uses reachable curl directly without obtaining a desktop artifact', async () => {
  const fixture = await artifactFixture()
  const root = join(await temporaryDirectory('phi-remote-direct-root-'), 'runtime')
  const bin = await temporaryDirectory('phi-remote-direct-bin-')
  const log = join(bin, 'curl.log')
  await fakeDownloader(bin, 'curl', {
    probeSucceeds: true,
    downloadSucceeds: true,
    source: fixture.remoteSource,
    log
  })
  const session = localSession(bin)
  let desktopDownloads = 0

  const result = await runInstall({
    session,
    root,
    artifact: fixture.plan,
    obtainLocalArtifact: async () => {
      desktopDownloads += 1
      return fixture.relay
    }
  })

  assert.equal(result.status, 'installed')
  assert.equal(result.transferMethod, 'remote-direct')
  assert.deepEqual(result.networkProbe, { status: 'reachable', tool: 'curl' })
  assert.equal(desktopDownloads, 0)
  assert.equal(session.uploads.length, 0)
})

it('returns remote-hash-mismatch for a reachable wget download with bad content', async () => {
  const fixture = await artifactFixture()
  const root = join(await temporaryDirectory('phi-remote-hash-root-'), 'runtime')
  const bin = await temporaryDirectory('phi-remote-hash-bin-')
  const log = join(bin, 'download.log')
  const badSource = join(bin, 'bad-artifact')
  const validContent = await readFile(fixture.remoteSource, 'utf8')
  await writeFile(badSource, validContent.replace('2.9.0', '2.9.1'))
  await fakeDownloader(bin, 'curl', {
    probeSucceeds: false,
    downloadSucceeds: false,
    source: badSource,
    log
  })
  await fakeDownloader(bin, 'wget', {
    probeSucceeds: true,
    downloadSucceeds: true,
    source: badSource,
    log
  })
  const session = localSession(bin)

  const result = await runInstall({
    session,
    root,
    artifact: fixture.plan,
    obtainLocalArtifact: async () => fixture.relay
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'remote-hash-mismatch')
  assert.deepEqual(result.networkProbe, { status: 'reachable', tool: 'wget' })
  assert.equal(session.uploads.length, 0)
  assert.match(await readFile(log, 'utf8'), /--spider -T 8 --tries=1/)
  await assert.rejects(access(join(root, 'bin', 'micromamba-2.9.0-0.download-fixture')))
})

it('falls back to desktop relay when a reachable direct download fails', async () => {
  const fixture = await artifactFixture()
  const root = join(await temporaryDirectory('phi-remote-fallback-root-'), 'runtime')
  const bin = await temporaryDirectory('phi-remote-fallback-bin-')
  const log = join(bin, 'curl.log')
  await fakeDownloader(bin, 'curl', {
    probeSucceeds: true,
    downloadSucceeds: false,
    source: fixture.remoteSource,
    log
  })
  const session = localSession(bin)
  const messages: string[] = []
  let desktopDownloads = 0

  const result = await runInstall({
    session,
    root,
    artifact: fixture.plan,
    messages,
    obtainLocalArtifact: async () => {
      desktopDownloads += 1
      return fixture.relay
    }
  })

  assert.equal(result.status, 'installed')
  assert.equal(result.transferMethod, 'desktop-relay')
  assert.equal(desktopDownloads, 1)
  assert.equal(session.uploads.length, 1)
  assert.ok(messages.some((message) => /直连下载失败.*本机中转/.test(message)))
})

it('uses desktop relay when curl and wget cannot reach the release URL', async () => {
  const fixture = await artifactFixture()
  const root = join(await temporaryDirectory('phi-remote-unreachable-root-'), 'runtime')
  const bin = await temporaryDirectory('phi-remote-unreachable-bin-')
  const log = join(bin, 'download.log')
  for (const name of ['curl', 'wget'] as const) {
    await fakeDownloader(bin, name, {
      probeSucceeds: false,
      downloadSucceeds: false,
      source: fixture.remoteSource,
      log
    })
  }
  const session = localSession(bin)

  const result = await runInstall({
    session,
    root,
    artifact: fixture.plan,
    obtainLocalArtifact: async () => fixture.relay
  })

  assert.equal(result.transferMethod, 'desktop-relay')
  assert.deepEqual(result.networkProbe, { status: 'unreachable' })
  assert.equal(session.uploads.length, 1)
})

it('uses desktop relay when the server has no curl or wget', async () => {
  const fixture = await artifactFixture()
  const root = join(await temporaryDirectory('phi-remote-no-tool-root-'), 'runtime')
  const bin = await temporaryDirectory('phi-remote-no-tool-bin-')
  const session = localSession(bin, '__PHI_MICROMAMBA_NETWORK__=no-tool')

  const result = await runInstall({
    session,
    root,
    artifact: fixture.plan,
    obtainLocalArtifact: async () => fixture.relay
  })

  assert.equal(result.transferMethod, 'desktop-relay')
  assert.deepEqual(result.networkProbe, { status: 'no-tool' })
  assert.equal(session.uploads.length, 1)
})

it('reuses an installed binary without probing or transferring again', async () => {
  const fixture = await artifactFixture()
  const root = join(await temporaryDirectory('phi-remote-idempotent-root-'), 'runtime')
  const bin = await temporaryDirectory('phi-remote-idempotent-bin-')
  const log = join(bin, 'curl.log')
  await fakeDownloader(bin, 'curl', {
    probeSucceeds: true,
    downloadSucceeds: true,
    source: fixture.remoteSource,
    log
  })
  const session = localSession(bin)
  const obtainLocalArtifact = async (): Promise<RemoteMicromambaArtifact> => fixture.relay
  const first = await runInstall({ session, root, artifact: fixture.plan, obtainLocalArtifact })
  const callsAfterFirst = (await readFile(log, 'utf8')).trim().split('\n').length
  const second = await runInstall({ session, root, artifact: fixture.plan, obtainLocalArtifact })

  assert.equal(first.status, 'installed')
  assert.equal(second.status, 'already-installed')
  assert.equal(second.transferMethod, 'existing')
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, callsAfterFirst)
  assert.equal(session.uploads.length, 0)
})
