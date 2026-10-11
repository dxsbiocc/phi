import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SshTransferDataPlane } from '../src/main/agent/transfer/ssh-data-plane'
import { FileTransferManager, FileTransferRegistry } from '../src/main/agent/transfer'
import { LocalHost } from '../src/main/agent/workspace-host/local-host'
import type { WorkspaceHost } from '../src/main/agent/workspace-host/types'
import { createLocalShellSession } from './helpers/localShellSession'

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

test('pure SSH upload streams binary chunks, verifies SHA-256, and publishes atomically', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-transfer-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-transfer-remote-'))
  const canonicalRemoteRoot = realpathSync(remoteRoot)
  const ssh = createLocalShellSession(remoteRoot)
  try {
    const content = Buffer.concat([
      Buffer.from('binary\0payload\n', 'utf8'),
      Buffer.alloc(2 * 1024 * 1024 + 31, 0xa7)
    ])
    const source = join(localRoot, 'source.bin')
    writeFileSync(source, content)
    const baseHost = new LocalHost(remoteRoot)
    let controlRoundTrips = 0
    let streamRoundTrips = 0
    const host: WorkspaceHost = {
      fs: baseHost.fs,
      exec: {
        run: (...args) => {
          controlRoundTrips += 1
          return baseHost.exec.run(...args)
        },
        spawnBackground: (...args) => baseHost.exec.spawnBackground(...args)
      },
      capabilities: () => baseHost.capabilities()
    }
    const plane = new SshTransferDataPlane({
      host,
      hostId: 'test-host',
      workspaceId: 'test-workspace',
      remoteRoot,
      canonicalRoot: canonicalRemoteRoot,
      openStream: (command) => {
        streamRoundTrips += 1
        return ssh.openStdio!(command)
      }
    })
    const result = await new FileTransferManager({
      registry: new FileTransferRegistry(join(localRoot, 'registry.json')),
      dataPlanes: [plane],
      policy: { chunkSizeBytes: 1024 * 1024, checkpointBytes: 1024 * 1024 }
    }).enqueue({
      transferId: 'ssh-upload',
      direction: 'upload',
      hostKey: 'test-host',
      dataPlaneId: plane.id,
      source: { kind: 'local-path', path: source },
      destination: {
        kind: 'remote-workspace-path',
        hostId: 'test-host',
        workspaceId: 'test-workspace',
        relativePath: 'uploaded.bin'
      },
      expectedSha256: sha256(content)
    }).completion

    assert.equal(result.sha256, sha256(content))
    assert.deepEqual(readFileSync(join(remoteRoot, 'uploaded.bin')), content)
    assert.equal(controlRoundTrips, 3)
    assert.equal(streamRoundTrips, 1)
  } finally {
    await ssh.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})

test('pure SSH download streams binary chunks and verifies both endpoints', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-download-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-download-remote-'))
  const canonicalRemoteRoot = realpathSync(remoteRoot)
  const ssh = createLocalShellSession(remoteRoot)
  try {
    const content = Buffer.concat([
      Buffer.alloc(1024 * 1024 + 17, 0x3c),
      Buffer.from('\0remote\nbinary', 'utf8')
    ])
    writeFileSync(join(remoteRoot, 'result.bin'), content)
    const destination = join(localRoot, 'downloaded.bin')
    const plane = new SshTransferDataPlane({
      host: new LocalHost(remoteRoot),
      hostId: 'test-host',
      workspaceId: 'test-workspace',
      remoteRoot,
      canonicalRoot: canonicalRemoteRoot,
      openStream: (command) => ssh.openStdio!(command)
    })
    const result = await new FileTransferManager({
      registry: new FileTransferRegistry(join(localRoot, 'registry.json')),
      dataPlanes: [plane],
      policy: { chunkSizeBytes: 256 * 1024, checkpointBytes: 512 * 1024 }
    }).enqueue({
      transferId: 'ssh-download',
      direction: 'download',
      hostKey: 'test-host',
      dataPlaneId: plane.id,
      source: {
        kind: 'remote-workspace-path',
        hostId: 'test-host',
        workspaceId: 'test-workspace',
        relativePath: 'result.bin'
      },
      destination: { kind: 'local-path', path: destination }
    }).completion

    assert.equal(result.sha256, sha256(content))
    assert.deepEqual(readFileSync(destination), content)
  } finally {
    await ssh.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})

test('pure SSH download rechecks the live source identity before publishing', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-download-live-identity-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-download-live-identity-remote-'))
  const ssh = createLocalShellSession(remoteRoot)
  try {
    const remotePath = join(remoteRoot, 'changing.bin')
    const content = Buffer.alloc(1024 * 1024 + 17, 0x31)
    writeFileSync(remotePath, content)
    const destination = join(localRoot, 'downloaded.bin')
    const plane = new SshTransferDataPlane({
      host: new LocalHost(remoteRoot),
      hostId: 'test-host',
      workspaceId: 'test-workspace',
      remoteRoot,
      canonicalRoot: realpathSync(remoteRoot),
      openStream: (command) => ssh.openStdio!(command)
    })
    const manager = new FileTransferManager({
      registry: new FileTransferRegistry(join(localRoot, 'registry.json')),
      dataPlanes: [plane],
      onEvent: (event) => {
        if (event.state === 'verifying')
          writeFileSync(remotePath, Buffer.alloc(content.length, 0x32))
      }
    })

    await assert.rejects(
      manager.enqueue({
        transferId: 'ssh-download-live-identity',
        direction: 'download',
        hostKey: 'test-host',
        dataPlaneId: plane.id,
        source: {
          kind: 'remote-workspace-path',
          hostId: 'test-host',
          workspaceId: 'test-workspace',
          relativePath: 'changing.bin'
        },
        destination: { kind: 'local-path', path: destination }
      }).completion,
      (error: unknown) =>
        ['SOURCE_CHANGED', 'HASH_MISMATCH'].includes(String((error as { code?: unknown })?.code))
    )
    assert.equal(existsSync(destination), false)
  } finally {
    await ssh.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})

test('pure SSH download refuses a partial replaced after SHA-256 verification', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-download-partial-race-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-download-partial-race-remote-'))
  const ssh = createLocalShellSession(remoteRoot)
  try {
    const content = Buffer.alloc(1024 * 1024 + 17, 0x41)
    writeFileSync(join(remoteRoot, 'result.bin'), content)
    const destination = join(localRoot, 'downloaded.bin')
    const transferId = 'ssh-download-partial-race'
    const partial = join(localRoot, `.downloaded.bin.phi-transfer-${transferId}.part`)
    let replaced = false
    let replacementFailure: unknown
    const plane = new SshTransferDataPlane({
      host: new LocalHost(remoteRoot),
      hostId: 'test-host',
      workspaceId: 'test-workspace',
      remoteRoot,
      canonicalRoot: realpathSync(remoteRoot),
      openStream: (command) => ssh.openStdio!(command)
    })
    const manager = new FileTransferManager({
      registry: new FileTransferRegistry(join(localRoot, 'registry.json')),
      dataPlanes: [plane],
      onEvent: (event) => {
        if (event.state !== 'publishing') return
        try {
          unlinkSync(partial)
          writeFileSync(partial, Buffer.alloc(content.length, 0x42), { mode: 0o600 })
          replaced = true
        } catch (error) {
          replacementFailure = error
        }
      }
    })

    const outcome = await manager
      .enqueue({
        transferId,
        direction: 'download',
        hostKey: 'test-host',
        dataPlaneId: plane.id,
        source: {
          kind: 'remote-workspace-path',
          hostId: 'test-host',
          workspaceId: 'test-workspace',
          relativePath: 'result.bin'
        },
        destination: { kind: 'local-path', path: destination }
      })
      .completion.then(
        () => null,
        (error: unknown) => error
      )
    assert.equal(replacementFailure, undefined)
    assert.equal(replaced, true)
    assert.equal((outcome as { code?: unknown } | null)?.code, 'INVALID_PARTIAL')
    assert.equal(existsSync(destination), false)
  } finally {
    await ssh.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})

test('pure SSH upload resumes from a validated durable remote offset', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-resume-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-resume-remote-'))
  const canonicalRemoteRoot = realpathSync(remoteRoot)
  const ssh = createLocalShellSession(remoteRoot)
  try {
    const content = Buffer.alloc(6 * 1024 * 1024 + 19, 0x6d)
    const source = join(localRoot, 'source.bin')
    writeFileSync(source, content)
    const plane = new SshTransferDataPlane({
      host: new LocalHost(remoteRoot),
      hostId: 'test-host',
      workspaceId: 'test-workspace',
      remoteRoot,
      canonicalRoot: canonicalRemoteRoot,
      openStream: (command) => ssh.openStdio!(command)
    })
    const registry = new FileTransferRegistry(join(localRoot, 'registry.json'))
    const request = {
      transferId: 'ssh-resume',
      direction: 'upload' as const,
      hostKey: 'test-host',
      dataPlaneId: plane.id,
      source: { kind: 'local-path' as const, path: source },
      destination: {
        kind: 'remote-workspace-path' as const,
        hostId: 'test-host',
        workspaceId: 'test-workspace',
        relativePath: 'resumed.bin'
      },
      expectedSha256: sha256(content)
    }
    const first = new FileTransferManager({
      registry,
      dataPlanes: [plane],
      policy: {
        chunkSizeBytes: 1024 * 1024,
        checkpointBytes: 1024 * 1024,
        progressBytes: 1,
        progressIntervalMs: 0
      },
      onEvent: (event) => {
        if (event.state === 'transferring' && event.bytesTransferred >= 1024 * 1024) {
          firstHandle.cancel()
        }
      }
    })
    const firstHandle = first.enqueue(request)
    await assert.rejects(firstHandle.completion, { code: 'ABORTED' })

    const result = await new FileTransferManager({
      registry,
      dataPlanes: [plane],
      policy: { chunkSizeBytes: 1024 * 1024, checkpointBytes: 1024 * 1024 }
    }).enqueue(request).completion

    assert.ok(result.resumedFrom >= 1024 * 1024)
    assert.deepEqual(readFileSync(join(remoteRoot, 'resumed.bin')), content)
  } finally {
    await ssh.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})

test('pure SSH download resumes from a validated local partial offset', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-download-resume-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-download-resume-remote-'))
  const ssh = createLocalShellSession(remoteRoot)
  try {
    const content = Buffer.alloc(5 * 1024 * 1024 + 7, 0x2a)
    writeFileSync(join(remoteRoot, 'large-result.bin'), content)
    const destination = join(localRoot, 'large-result.bin')
    const plane = new SshTransferDataPlane({
      host: new LocalHost(remoteRoot),
      hostId: 'test-host',
      workspaceId: 'test-workspace',
      remoteRoot,
      canonicalRoot: realpathSync(remoteRoot),
      openStream: (command) => ssh.openStdio!(command)
    })
    const registry = new FileTransferRegistry(join(localRoot, 'registry.json'))
    const request = {
      transferId: 'ssh-download-resume',
      direction: 'download' as const,
      hostKey: 'test-host',
      dataPlaneId: plane.id,
      source: {
        kind: 'remote-workspace-path' as const,
        hostId: 'test-host',
        workspaceId: 'test-workspace',
        relativePath: 'large-result.bin'
      },
      destination: { kind: 'local-path' as const, path: destination }
    }
    const first = new FileTransferManager({
      registry,
      dataPlanes: [plane],
      policy: {
        chunkSizeBytes: 512 * 1024,
        checkpointBytes: 512 * 1024,
        progressBytes: 1,
        progressIntervalMs: 0
      },
      onEvent: (event) => {
        if (event.state === 'transferring' && event.bytesTransferred >= 512 * 1024) {
          firstHandle.cancel()
        }
      }
    })
    const firstHandle = first.enqueue(request)
    await assert.rejects(firstHandle.completion, { code: 'ABORTED' })

    const result = await new FileTransferManager({
      registry,
      dataPlanes: [plane],
      policy: { chunkSizeBytes: 512 * 1024, checkpointBytes: 512 * 1024 }
    }).enqueue(request).completion

    assert.ok(result.resumedFrom >= 512 * 1024)
    assert.deepEqual(readFileSync(destination), content)
  } finally {
    await ssh.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})

test('pure SSH resume rejects a remote partial whose confirmed offset hash changed', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-tamper-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-tamper-remote-'))
  const ssh = createLocalShellSession(remoteRoot)
  try {
    const content = Buffer.alloc(4 * 1024 * 1024, 0x52)
    const source = join(localRoot, 'source.bin')
    writeFileSync(source, content)
    const plane = new SshTransferDataPlane({
      host: new LocalHost(remoteRoot),
      hostId: 'test-host',
      workspaceId: 'test-workspace',
      remoteRoot,
      canonicalRoot: realpathSync(remoteRoot),
      openStream: (command) => ssh.openStdio!(command)
    })
    const registry = new FileTransferRegistry(join(localRoot, 'registry.json'))
    const request = {
      transferId: 'ssh-tamper',
      direction: 'upload' as const,
      hostKey: 'test-host',
      dataPlaneId: plane.id,
      source: { kind: 'local-path' as const, path: source },
      destination: {
        kind: 'remote-workspace-path' as const,
        hostId: 'test-host',
        workspaceId: 'test-workspace',
        relativePath: 'tampered.bin'
      }
    }
    const first = new FileTransferManager({
      registry,
      dataPlanes: [plane],
      policy: {
        chunkSizeBytes: 1024 * 1024,
        checkpointBytes: 1024 * 1024,
        progressBytes: 1,
        progressIntervalMs: 0
      },
      onEvent: (event) => {
        if (event.state === 'transferring' && event.bytesTransferred >= 1024 * 1024) {
          firstHandle.cancel()
        }
      }
    })
    const firstHandle = first.enqueue(request)
    await assert.rejects(firstHandle.completion, { code: 'ABORTED' })

    const partial = join(remoteRoot, '.tampered.bin.phi-transfer-ssh-tamper.part')
    const manifest = JSON.parse(readFileSync(`${partial}.json`, 'utf8')) as {
      durableOffset: number
    }
    assert.ok(manifest.durableOffset > 0)
    const descriptor = openSync(partial, 'r+')
    writeSync(descriptor, Buffer.from([0xff]), 0, 1, manifest.durableOffset - 1)
    closeSync(descriptor)

    await assert.rejects(
      new FileTransferManager({
        registry,
        dataPlanes: [plane],
        policy: { chunkSizeBytes: 1024 * 1024, checkpointBytes: 1024 * 1024 }
      }).enqueue(request).completion,
      { code: 'HASH_MISMATCH' }
    )
  } finally {
    await ssh.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})

test('pure SSH preflight fails explicitly when the server has no SHA-256 tool', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-no-hash-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-no-hash-remote-'))
  const binRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-no-hash-bin-'))
  const ssh = createLocalShellSession(remoteRoot)
  try {
    symlinkSync('/bin/sh', join(binRoot, 'sh'))
    const source = join(localRoot, 'source.bin')
    writeFileSync(source, 'must not transfer without a server digest')
    const baseHost = new LocalHost(remoteRoot)
    const host: WorkspaceHost = {
      fs: baseHost.fs,
      exec: {
        run: (command, options) =>
          baseHost.exec.run(command, { ...options, env: { ...options.env, PATH: binRoot } }),
        spawnBackground: (...args) => baseHost.exec.spawnBackground(...args)
      },
      capabilities: () => baseHost.capabilities()
    }
    const plane = new SshTransferDataPlane({
      host,
      hostId: 'test-host',
      workspaceId: 'test-workspace',
      remoteRoot,
      canonicalRoot: realpathSync(remoteRoot),
      openStream: (command) => ssh.openStdio!(command)
    })

    await assert.rejects(
      new FileTransferManager({
        registry: new FileTransferRegistry(join(localRoot, 'registry.json')),
        dataPlanes: [plane]
      }).enqueue({
        transferId: 'ssh-no-hash',
        direction: 'upload',
        hostKey: 'test-host',
        dataPlaneId: plane.id,
        source: { kind: 'local-path', path: source },
        destination: {
          kind: 'remote-workspace-path',
          hostId: 'test-host',
          workspaceId: 'test-workspace',
          relativePath: 'blocked.bin'
        }
      }).completion,
      { code: 'HASH_UNAVAILABLE' }
    )
    assert.equal(existsSync(join(remoteRoot, 'blocked.bin')), false)
  } finally {
    await ssh.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
    rmSync(binRoot, { recursive: true, force: true })
  }
})

test('pure SSH strictly quotes remote paths containing shell metacharacters', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-quote-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-quote-remote-'))
  const ssh = createLocalShellSession(remoteRoot)
  try {
    const remoteName = "result'; touch PWNED; echo '.bin"
    const content = Buffer.from('quoted remote path payload')
    writeFileSync(join(remoteRoot, remoteName), content)
    const destination = join(localRoot, 'downloaded.bin')
    const plane = new SshTransferDataPlane({
      host: new LocalHost(remoteRoot),
      hostId: 'test-host',
      workspaceId: 'test-workspace',
      remoteRoot,
      canonicalRoot: realpathSync(remoteRoot),
      openStream: (command) => ssh.openStdio!(command)
    })

    await new FileTransferManager({
      registry: new FileTransferRegistry(join(localRoot, 'registry.json')),
      dataPlanes: [plane]
    }).enqueue({
      transferId: 'ssh-quoted-path',
      direction: 'download',
      hostKey: 'test-host',
      dataPlaneId: plane.id,
      source: {
        kind: 'remote-workspace-path',
        hostId: 'test-host',
        workspaceId: 'test-workspace',
        relativePath: remoteName
      },
      destination: { kind: 'local-path', path: destination }
    }).completion

    assert.deepEqual(readFileSync(destination), content)
    assert.equal(existsSync(join(remoteRoot, 'PWNED')), false)
    await assert.rejects(
      plane.open({
        transferId: 'ssh-traversal',
        direction: 'download',
        hostKey: 'test-host',
        dataPlaneId: plane.id,
        source: {
          kind: 'remote-workspace-path',
          hostId: 'test-host',
          workspaceId: 'test-workspace',
          relativePath: '../escaped.bin'
        },
        destination: { kind: 'local-path', path: join(localRoot, 'escaped.bin') }
      }),
      { code: 'INVALID_REQUEST' }
    )
  } finally {
    await ssh.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})

test('pure SSH cancellation escalates a TERM-resistant stream worker to KILL', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-kill-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-kill-remote-'))
  const binRoot = mkdtempSync(join(tmpdir(), 'phi-ssh-kill-bin-'))
  const pidPath = join(localRoot, 'cat.pid')
  const oldPath = process.env.PATH
  const ssh = createLocalShellSession(remoteRoot)
  try {
    const catShim = join(binRoot, 'cat')
    writeFileSync(
      catShim,
      [
        '#!/usr/bin/perl',
        '$SIG{TERM} = "IGNORE";',
        '$SIG{HUP} = "IGNORE";',
        'open my $pid, ">", $ENV{PHI_STUB_CAT_PID} or die $!;',
        'print {$pid} "$$\\n";',
        'close $pid;',
        'my $buffer;',
        'while (sysread(STDIN, $buffer, 65536)) { syswrite(STDOUT, $buffer); }',
        'while (1) { select undef, undef, undef, 0.1; }',
        ''
      ].join('\n')
    )
    chmodSync(catShim, 0o755)
    process.env.PATH = `${binRoot}:${oldPath ?? ''}`
    process.env.PHI_STUB_CAT_PID = pidPath
    const source = join(localRoot, 'source.bin')
    writeFileSync(source, Buffer.alloc(3 * 1024 * 1024, 0x7b))
    const plane = new SshTransferDataPlane({
      host: new LocalHost(remoteRoot),
      hostId: 'test-host',
      workspaceId: 'test-workspace',
      remoteRoot,
      canonicalRoot: realpathSync(remoteRoot),
      openStream: (command) => ssh.openStdio!(command)
    })
    const manager = new FileTransferManager({
      registry: new FileTransferRegistry(join(localRoot, 'registry.json')),
      dataPlanes: [plane],
      policy: {
        chunkSizeBytes: 1024 * 1024,
        checkpointBytes: 1024 * 1024,
        progressBytes: 1,
        progressIntervalMs: 0
      },
      onEvent: (event) => {
        if (event.state === 'transferring' && event.bytesTransferred >= 1024 * 1024) {
          handle.cancel()
        }
      }
    })
    const handle = manager.enqueue({
      transferId: 'ssh-term-kill',
      direction: 'upload',
      hostKey: 'test-host',
      dataPlaneId: plane.id,
      source: { kind: 'local-path', path: source },
      destination: {
        kind: 'remote-workspace-path',
        hostId: 'test-host',
        workspaceId: 'test-workspace',
        relativePath: 'cancelled.bin'
      }
    })
    await assert.rejects(handle.completion, { code: 'ABORTED' })

    const pid = Number(readFileSync(pidPath, 'utf8').trim())
    await waitForProcessExit(pid)
  } finally {
    process.env.PATH = oldPath
    delete process.env.PHI_STUB_CAT_PID
    await ssh.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
    rmSync(binRoot, { recursive: true, force: true })
  }
})

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`stream worker ${pid} survived TERM-to-KILL escalation`)
}
