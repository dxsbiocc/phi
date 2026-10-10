import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const PRIMARY_URL = 'https://github.com/mamba-org/micromamba-releases/download/2.9.0/micromamba'
const USER_URL = `https://user-mirror.example/${PRIMARY_URL}`
const MIRROR_URL = `https://gh-proxy.com/${PRIMARY_URL}`
const SECOND_MIRROR_URL = `https://ghfast.top/${PRIMARY_URL}`

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

type ProbeResult = 'usable' | 'low' | 'timeout'

interface FakeRoute {
  host: string
  probe: ProbeResult
  source?: string
}

function routeCases(routes: readonly FakeRoute[]): string {
  return routes
    .map(
      ({ host, probe, source }) =>
        `  https://${host}/*) phi_probe_result=${probe}; phi_source='${source ?? ''}' ;;`
    )
    .join('\n')
}

async function fakeDownloader(
  bin: string,
  name: 'curl' | 'wget',
  routes: readonly FakeRoute[],
  log: string
): Promise<void> {
  const script = `#!/bin/sh
phi_probe=0
phi_dest=
phi_url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --range|--header=*) phi_probe=1 ;;
    -o|-O) shift; phi_dest=$1 ;;
    https://*) phi_url=$1 ;;
  esac
  shift
done
printf '%s %s\n' "$phi_url" "$phi_probe" >> '${log}'
phi_probe_result=timeout
phi_source=
case "$phi_url" in
${routeCases(routes)}
esac
if [ "$phi_probe" = 1 ]; then
  [ "$phi_probe_result" = timeout ] && exit 28
  if [ '${name}' = curl ]; then
    [ "$phi_probe_result" = usable ] && printf '262144 102400' || printf '262144 40960'
  elif [ "$phi_probe_result" = usable ]; then
    dd if=/dev/zero of="$phi_dest" bs=262144 count=1 2>/dev/null
  else
    dd if=/dev/zero of="$phi_dest" bs=40960 count=1 2>/dev/null
  fi
  exit 0
fi
[ -n "$phi_source" ] || exit 23
cp "$phi_source" "$phi_dest"
`
  const path = join(bin, name)
  await writeFile(path, script)
  await chmod(path, 0o755)
}

async function artifactFixture(): Promise<{
  plan: RemoteMicromambaArtifact & { url: string; urls: readonly string[] }
  relay: RemoteMicromambaArtifact
  remoteSource: string
  badSource: string
}> {
  const dir = await temporaryDirectory('phi-remote-direct-artifact-')
  const remoteSource = join(dir, 'remote-micromamba')
  const badSource = join(dir, 'bad-micromamba')
  const relayPath = join(dir, 'relay-micromamba')
  const content = [
    '#!/bin/sh',
    'phi_executable=$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || printf \'%s\\n\' "$0")',
    'if [ "$(basename "$phi_executable")" != micromamba ]; then',
    '  printf \'Error unknown MAMBA_EXE: "%s", filename must be mamba or micromamba\\n\' "$phi_executable" >&2',
    '  exit 1',
    'fi',
    'if [ "$1" = "--version" ]; then echo 2.9.0; exit 0; fi',
    'if [ "$1" = "--rc-file" ] && [ "$3" = "info" ]; then echo "platform : linux-64"; exit 0; fi',
    'if [ "$1" = "--rc-file" ] && [ "$3" = "run" ]; then shift 5; exec "$@"; fi',
    'exit 2',
    ''
  ].join('\n')
  await Promise.all([
    writeFile(remoteSource, content),
    writeFile(relayPath, content),
    writeFile(badSource, 'proxy error page')
  ])
  await Promise.all([chmod(remoteSource, 0o755), chmod(relayPath, 0o755)])
  const metadata = {
    version: '2.9.0-0',
    platform: 'linux-x64' as const,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content)
  }
  return {
    plan: {
      ...metadata,
      localPath: join(dir, 'desktop-cache-missing'),
      url: PRIMARY_URL,
      urls: [PRIMARY_URL]
    },
    relay: { ...metadata, localPath: relayPath },
    remoteSource,
    badSource
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
  artifact: RemoteMicromambaArtifact & { url: string; urls: readonly string[] }
  relay: RemoteMicromambaArtifact
  messages?: string[]
}): Promise<RemoteMicromambaResult> {
  return ensureRemoteMicromamba(input.session, {
    runtimeRoot: input.root,
    confirmedWarnings: [],
    artifact: input.artifact,
    obtainLocalArtifact: async () => input.relay,
    checkRuntimeRoot: async () => checkedRoot(input.root),
    randomId: () => 'fixture',
    onProgress: ({ message }) => input.messages?.push(message)
  })
}

async function installFixture(input: {
  urls: readonly string[]
  curl: readonly FakeRoute[]
  wget?: readonly FakeRoute[]
  messages?: string[]
}): Promise<{ result: RemoteMicromambaResult; session: LocalShellSession; log: string }> {
  const fixture = await artifactFixture()
  const root = join(await temporaryDirectory('phi-remote-direct-root-'), 'runtime')
  const bin = await temporaryDirectory('phi-remote-direct-bin-')
  const log = join(bin, 'downloads.log')
  await fakeDownloader(bin, 'curl', input.curl, log)
  await fakeDownloader(bin, 'wget', input.wget ?? [], log)
  const session = localSession(bin)
  const result = await runInstall({
    session,
    root,
    artifact: { ...fixture.plan, urls: input.urls },
    relay: fixture.relay,
    messages: input.messages
  })
  return { result, session, log }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

it('tries a mirror with wget when the primary speed probe times out', async () => {
  const fixture = await artifactFixture()
  const { result, session } = await installFixture({
    urls: [PRIMARY_URL, MIRROR_URL],
    curl: [],
    wget: [
      { host: 'github.com', probe: 'timeout' },
      { host: 'gh-proxy.com', probe: 'usable', source: fixture.remoteSource }
    ]
  })

  assert.equal(result.status, 'installed')
  assert.equal(result.transferMethod, 'remote-direct')
  assert.deepEqual(result.networkProbe, { status: 'reachable', tool: 'wget', host: 'gh-proxy.com' })
  assert.equal(session.uploads.length, 0)
})

it('discards a mirror error page and downloads from the next source', async () => {
  const fixture = await artifactFixture()
  const { result, session } = await installFixture({
    urls: [MIRROR_URL, SECOND_MIRROR_URL],
    curl: [
      { host: 'gh-proxy.com', probe: 'usable', source: fixture.badSource },
      { host: 'ghfast.top', probe: 'usable', source: fixture.remoteSource }
    ]
  })

  assert.equal(result.status, 'installed')
  assert.deepEqual(result.networkProbe, { status: 'reachable', tool: 'curl', host: 'ghfast.top' })
  assert.equal(session.uploads.length, 0)
})

it('falls back to relay only after all sources fail and reports host-only results', async () => {
  const messages: string[] = []
  const { result, session } = await installFixture({
    urls: [PRIMARY_URL, MIRROR_URL],
    curl: [
      { host: 'github.com', probe: 'usable' },
      { host: 'gh-proxy.com', probe: 'timeout' }
    ],
    messages
  })

  assert.equal(result.status, 'installed')
  assert.equal(result.transferMethod, 'desktop-relay')
  assert.deepEqual(result.networkProbe, { status: 'unreachable' })
  assert.equal(session.uploads.length, 1)
  assert.ok(
    messages.some((message) => /github\.com：下载失败.*gh-proxy\.com：不可用/.test(message))
  )
  assert.ok(
    messages.every((message) => !message.includes('mamba-org') && !message.includes('https://'))
  )
})

it('tries the user mirror before manifest mirrors', async () => {
  const fixture = await artifactFixture()
  const { result, log } = await installFixture({
    urls: [PRIMARY_URL, USER_URL, MIRROR_URL],
    curl: [
      { host: 'github.com', probe: 'timeout' },
      { host: 'user-mirror.example', probe: 'usable', source: fixture.remoteSource },
      { host: 'gh-proxy.com', probe: 'usable', source: fixture.remoteSource }
    ]
  })

  assert.equal(result.transferMethod, 'remote-direct')
  assert.deepEqual(result.networkProbe, {
    status: 'reachable',
    tool: 'curl',
    host: 'user-mirror.example'
  })
  const calls = await readFile(log, 'utf8')
  assert.ok(calls.includes(USER_URL))
  assert.ok(!calls.includes(MIRROR_URL))
})

it('rejects a source below 50 KiB/s and uses the next source', async () => {
  const fixture = await artifactFixture()
  const { result } = await installFixture({
    urls: [PRIMARY_URL, MIRROR_URL],
    curl: [
      { host: 'github.com', probe: 'low', source: fixture.remoteSource },
      { host: 'gh-proxy.com', probe: 'usable', source: fixture.remoteSource }
    ]
  })

  assert.deepEqual(result.networkProbe, { status: 'reachable', tool: 'curl', host: 'gh-proxy.com' })
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
    relay: fixture.relay
  })

  assert.equal(result.transferMethod, 'desktop-relay')
  assert.deepEqual(result.networkProbe, { status: 'no-tool' })
  assert.equal(session.uploads.length, 1)
})

it('reuses an installed binary without another speed probe or transfer', async () => {
  const fixture = await artifactFixture()
  const root = join(await temporaryDirectory('phi-remote-idempotent-root-'), 'runtime')
  const bin = await temporaryDirectory('phi-remote-idempotent-bin-')
  const log = join(bin, 'downloads.log')
  const routes = [{ host: 'github.com', probe: 'usable' as const, source: fixture.remoteSource }]
  await fakeDownloader(bin, 'curl', routes, log)
  await fakeDownloader(bin, 'wget', [], log)
  const session = localSession(bin)
  const input = { session, root, artifact: fixture.plan, relay: fixture.relay }
  const first = await runInstall(input)
  const callsAfterFirst = await readFile(log, 'utf8')
  const second = await runInstall(input)

  assert.equal(first.status, 'installed')
  assert.equal(second.status, 'already-installed')
  assert.equal(second.transferMethod, 'existing')
  assert.equal(await readFile(log, 'utf8'), callsAfterFirst)
  assert.equal(session.uploads.length, 0)
})
