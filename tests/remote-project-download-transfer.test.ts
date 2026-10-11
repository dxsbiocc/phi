import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  deterministicRemoteDownloadId,
  RemoteProjectDownloadDataPlane,
  type RemoteProjectDownloadContext
} from '../src/main/agent/download/remote-project-download-data-plane'
import {
  FileTransferManager,
  FileTransferRegistry,
  type TransferEvent,
  type TransferRequest
} from '../src/main/agent/transfer'
import type { RemoteExecBoundedOptions } from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession, type LocalShellSession } from './helpers/localShellSession'

const MIB = 1024 * 1024

test('server-direct curl cancel checkpoint resumes after manager restart and removes metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-http-transfer-'))
  const oldPath = process.env.PATH
  const oldSource = process.env.PHI_FAKE_HTTP_SOURCE
  const oldDigest = process.env.PHI_FAKE_HTTP_SHA256
  const oldGate = process.env.PHI_FAKE_HTTP_GATE
  const oldLog = process.env.PHI_FAKE_HTTP_LOG
  try {
    const bin = join(root, 'bin')
    const remoteRootInput = join(root, 'remote')
    const source = join(root, 'source.bin')
    const gate = join(root, 'allow-finish')
    const log = join(root, 'curl.log')
    mkdirSync(bin)
    mkdirSync(remoteRootInput)
    const remoteRoot = realpathSync(remoteRootInput)
    const destination = join(remoteRoot, 'result.bin')
    const content = Buffer.alloc(65 * MIB + 257, 0x5a)
    writeFileSync(source, content)
    const expected = createHash('sha256').update(content).digest('hex')
    installCurlStub(join(bin, 'curl'))
    process.env.PATH = `${bin}:${oldPath ?? ''}`
    process.env.PHI_FAKE_HTTP_SOURCE = source
    process.env.PHI_FAKE_HTTP_SHA256 = expected
    process.env.PHI_FAKE_HTTP_GATE = gate
    process.env.PHI_FAKE_HTTP_LOG = log

    const session = boundedLocalSession(remoteRoot)
    const sourceFingerprint = createHash('sha256')
      .update('https://example.org/result.bin')
      .digest('hex')
    const transferId = deterministicRemoteDownloadId({
      hostKey: 'profile-1',
      workspaceId: 'project-1',
      destination,
      sourceFingerprint
    })
    const context: RemoteProjectDownloadContext = {
      transferId,
      hostKey: 'profile-1',
      workspaceId: 'project-1',
      session,
      url: 'https://example.org/result.bin?token=must-not-leak',
      sourceFingerprint,
      destination,
      relativePath: 'result.bin',
      canonicalRoot: remoteRoot,
      maxFileBytes: 128 * MIB
    }
    const request: TransferRequest = {
      transferId,
      direction: 'download',
      hostKey: 'profile-1',
      dataPlaneId: 'remote-http-direct',
      source: {
        kind: 'remote-workspace-path',
        hostId: 'profile-1',
        workspaceId: 'project-1',
        relativePath: `.phi-http-source/${sourceFingerprint}`
      },
      destination: {
        kind: 'remote-workspace-path',
        hostId: 'profile-1',
        workspaceId: 'project-1',
        relativePath: 'result.bin'
      }
    }
    const registry = new FileTransferRegistry(join(root, 'registry.json'))
    const firstPlane = new RemoteProjectDownloadDataPlane()
    firstPlane.bind(context)
    const firstEvents: TransferEvent[] = []
    let cancelFirst = (): void => undefined
    const firstManager = new FileTransferManager({
      registry,
      dataPlanes: [firstPlane],
      onEvent: (event) => {
        firstEvents.push(event)
        if (event.state === 'transferring' && event.bytesTransferred >= 64 * MIB) {
          cancelFirst()
        }
      }
    })
    const firstHandle = firstManager.enqueue(request)
    cancelFirst = () => firstHandle.cancel()
    await assert.rejects(firstHandle.completion, { code: 'ABORTED' })
    firstPlane.unbind(transferId)

    const retained = await registry.list()
    assert.equal(retained.length, 1)
    assert.equal(retained[0]?.status, 'cancelled')
    assert.ok((retained[0]?.retainedBytes ?? 0) >= 64 * MIB)
    assert.ok(
      firstEvents.every(
        (event) =>
          !JSON.stringify(event).includes('must-not-leak') &&
          !JSON.stringify(event).includes(remoteRoot)
      )
    )

    writeFileSync(gate, 'continue')
    const resumedPlane = new RemoteProjectDownloadDataPlane()
    resumedPlane.bind(context)
    const resumed = await new FileTransferManager({
      registry,
      dataPlanes: [resumedPlane]
    }).enqueue(request).completion
    resumedPlane.unbind(transferId)

    assert.ok(resumed.resumedFrom >= 64 * MIB)
    assert.equal(resumed.sha256, expected)
    assert.deepEqual(readFileSync(destination), content)
    assert.deepEqual(await registry.list(), [])
    assert.deepEqual(
      readdirSync(remoteRoot).filter((name) => name.includes('phi-transfer-')),
      []
    )
    assert.match(readFileSync(log, 'utf8'), /offset=67108864 if_range="fixture-v1"/)
    assert.ok(session.commands.some((command) => command.includes('--continue-at -')))
  } finally {
    process.env.PATH = oldPath
    restoreEnv('PHI_FAKE_HTTP_SOURCE', oldSource)
    restoreEnv('PHI_FAKE_HTTP_SHA256', oldDigest)
    restoreEnv('PHI_FAKE_HTTP_GATE', oldGate)
    restoreEnv('PHI_FAKE_HTTP_LOG', oldLog)
    rmSync(root, { recursive: true, force: true })
  }
})

function boundedLocalSession(remoteRoot: string): LocalShellSession {
  const session = createLocalShellSession(remoteRoot)
  session.execBounded = async (command: string, options: RemoteExecBoundedOptions) => {
    options.signal?.throwIfAborted()
    const output = await session.exec(command)
    options.signal?.throwIfAborted()
    return {
      ...output,
      stdoutTruncated: false as const,
      stderrTruncated: false as const
    }
  }
  return session
}

function installCurlStub(path: string): void {
  writeFileSync(
    path,
    `#!/bin/bash
set -eu
head_only=0
headers=
output=
if_range=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --head) head_only=1; shift ;;
    --dump-header|--output|--write-out|--header|--resolve|--max-filesize|--connect-timeout|--max-time|--proto|--max-redirs)
      option=$1; value=$2; shift 2
      case "$option" in
        --dump-header) headers=$value ;;
        --output) output=$value ;;
        --header) case "$value" in 'If-Range: '*) if_range=\${value#If-Range: } ;; esac ;;
      esac
      ;;
    --continue-at) shift 2 ;;
    --noproxy) shift 2 ;;
    --fail|--silent|--show-error|-q) shift ;;
    *) shift ;;
  esac
done
size=$(wc -c < "$PHI_FAKE_HTTP_SOURCE" | tr -d ' ')
if [ "$head_only" -eq 1 ]; then
  printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\nETag: "fixture-v1"\r\nX-Checksum-Sha256: %s\r\n\r\n' "$size" "$PHI_FAKE_HTTP_SHA256" > "$headers"
  printf 200
  exit 0
fi
offset=0
if [ -n "$output" ] && [ -f "$output" ]; then offset=$(wc -c < "$output" | tr -d ' '); fi
printf 'offset=%s if_range=%s\n' "$offset" "$if_range" >> "$PHI_FAKE_HTTP_LOG"
if [ "$offset" -gt 0 ]; then
  printf 'HTTP/1.1 206 Partial Content\r\nContent-Range: bytes %s-%s/%s\r\n\r\n' "$offset" "$((size - 1))" "$size" > "$headers"
  tail -c +$((offset + 1)) "$PHI_FAKE_HTTP_SOURCE" >> "$output"
  printf 206
  exit 0
fi
printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\n\r\n' "$size" > "$headers"
dd if="$PHI_FAKE_HTTP_SOURCE" of="$output" bs=1048576 count=64 2>/dev/null
while [ ! -e "$PHI_FAKE_HTTP_GATE" ]; do sleep 0.05; done
tail -c +$((64 * 1048576 + 1)) "$PHI_FAKE_HTTP_SOURCE" >> "$output"
printf 200
`
  )
  chmodSync(path, 0o755)
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
test('server-direct curl rejects an expected SHA-256 mismatch against the remote digest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-http-digest-'))
  const saved = {
    path: process.env.PATH,
    source: process.env.PHI_FAKE_HTTP_SOURCE,
    digest: process.env.PHI_FAKE_HTTP_SHA256,
    gate: process.env.PHI_FAKE_HTTP_GATE,
    log: process.env.PHI_FAKE_HTTP_LOG
  }
  try {
    const bin = join(root, 'bin')
    const remoteRootInput = join(root, 'remote')
    mkdirSync(bin)
    mkdirSync(remoteRootInput)
    const remoteRoot = realpathSync(remoteRootInput)
    const source = join(root, 'source.bin')
    const destination = join(remoteRoot, 'digest.bin')
    const gate = join(root, 'gate')
    const log = join(root, 'curl.log')
    const content = Buffer.from('remote digest evidence')
    const actual = createHash('sha256').update(content).digest('hex')
    writeFileSync(source, content)
    writeFileSync(gate, 'ready')
    installCurlStub(join(bin, 'curl'))
    process.env.PATH = `${bin}:${saved.path ?? ''}`
    process.env.PHI_FAKE_HTTP_SOURCE = source
    process.env.PHI_FAKE_HTTP_SHA256 = actual
    process.env.PHI_FAKE_HTTP_GATE = gate
    process.env.PHI_FAKE_HTTP_LOG = log

    const session = boundedLocalSession(remoteRoot)
    const sourceFingerprint = createHash('sha256')
      .update('https://example.org/digest.bin')
      .digest('hex')
    const transferId = deterministicRemoteDownloadId({
      hostKey: 'profile-1',
      workspaceId: 'project-1',
      destination,
      sourceFingerprint
    })
    const plane = new RemoteProjectDownloadDataPlane()
    plane.bind({
      transferId,
      hostKey: 'profile-1',
      workspaceId: 'project-1',
      session,
      url: 'https://example.org/digest.bin',
      sourceFingerprint,
      destination,
      relativePath: 'digest.bin',
      canonicalRoot: remoteRoot,
      maxFileBytes: MIB
    })
    const completion = new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [plane]
    }).enqueue({
      transferId,
      direction: 'download',
      hostKey: 'profile-1',
      dataPlaneId: plane.id,
      source: {
        kind: 'remote-workspace-path',
        hostId: 'profile-1',
        workspaceId: 'project-1',
        relativePath: `.phi-http-source/${sourceFingerprint}`
      },
      destination: {
        kind: 'remote-workspace-path',
        hostId: 'profile-1',
        workspaceId: 'project-1',
        relativePath: 'digest.bin'
      },
      expectedSha256: 'b'.repeat(64)
    }).completion

    await assert.rejects(completion, { code: 'HASH_MISMATCH' })
    assert.equal(existsSync(destination), false)
  } finally {
    restoreEnv('PATH', saved.path)
    restoreEnv('PHI_FAKE_HTTP_SOURCE', saved.source)
    restoreEnv('PHI_FAKE_HTTP_SHA256', saved.digest)
    restoreEnv('PHI_FAKE_HTTP_GATE', saved.gate)
    restoreEnv('PHI_FAKE_HTTP_LOG', saved.log)
    rmSync(root, { recursive: true, force: true })
  }
})

test('server-direct transfer rejects an in-root parent symlink swap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-http-parent-race-'))
  try {
    const remoteRoot = realpathSync(root)
    const originalParent = join(remoteRoot, 'downloads')
    const movedParent = join(remoteRoot, 'downloads-original')
    const attackerParent = join(remoteRoot, 'other')
    mkdirSync(originalParent)
    mkdirSync(attackerParent)
    const session = boundedLocalSession(remoteRoot)
    const sourceFingerprint = 'c'.repeat(64)
    const destination = join(originalParent, 'result.bin')
    const transferId = deterministicRemoteDownloadId({
      hostKey: 'profile-1',
      workspaceId: 'project-1',
      destination,
      sourceFingerprint
    })
    const plane = new RemoteProjectDownloadDataPlane()
    plane.bind({
      transferId,
      hostKey: 'profile-1',
      workspaceId: 'project-1',
      session,
      url: 'https://example.org/result.bin',
      sourceFingerprint,
      destination,
      relativePath: 'downloads/result.bin',
      canonicalRoot: remoteRoot,
      maxFileBytes: MIB
    })
    renameSync(originalParent, movedParent)
    symlinkSync(attackerParent, originalParent)
    const transferSession = await plane.open({
      transferId,
      direction: 'download',
      hostKey: 'profile-1',
      dataPlaneId: plane.id,
      source: {
        kind: 'remote-workspace-path',
        hostId: 'profile-1',
        workspaceId: 'project-1',
        relativePath: `.phi-http-source/${sourceFingerprint}`
      },
      destination: {
        kind: 'remote-workspace-path',
        hostId: 'profile-1',
        workspaceId: 'project-1',
        relativePath: 'downloads/result.bin'
      }
    })
    await assert.rejects(transferSession.preflight(new AbortController().signal), {
      code: 'INVALID_REQUEST'
    })
    assert.equal(existsSync(join(attackerParent, 'result.bin')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
