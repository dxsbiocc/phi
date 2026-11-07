import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { remoteWorkspaceBindingHash } from '../src/main/agent/remote-workspace-boundary'
import { deriveRemoteSessionPaths } from '../src/main/agent/engine/rpc/session-storage/paths'
import { serializeRemoteSessionManifest } from '../src/main/agent/engine/rpc/session-storage/remote-manifest'
import type { Project } from '../src/main/agent/projects'
import type { RemoteWorkspaceHostBinding } from '../src/main/agent/remote-workspace-boundary'
import {
  deletesOnServer,
  buildRemoteKernelSessionDeleteCommand,
  buildRemoteSessionDeleteCommand,
  prepareRemotePhiDeletion,
  RemoteSessionDeleteUnavailableError
} from '../src/main/agent/session/remote-session-delete'
import {
  remoteOmpDurableSessionKey,
  type KernelRemoteRuntimeRef
} from '../src/main/agent/session/runtime-reference'
import {
  beginRuntimeReferenceAdoption,
  createPhiSession,
  findPhiSessionById
} from '../src/main/agent/session/session-store'

async function fixture(
  run: (context: {
    sessionId: string
    project: Project
    binding: RemoteWorkspaceHostBinding
  }) => Promise<void>
): Promise<void> {
  const previous = process.env.PI_CODING_AGENT_DIR
  const directory = mkdtempSync(join(tmpdir(), 'phi-remote-delete-'))
  process.env.PI_CODING_AGENT_DIR = directory
  try {
    const projectRoot = join(realpathSync(directory), 'remote-project-研究')
    const projectId = 'delete-project'
    const hostProfileId = 'delete-host'
    const binding: RemoteWorkspaceHostBinding = {
      sessionId: '',
      projectId,
      hostAlias: 'unused',
      remoteRoot: projectRoot,
      canonicalRoot: projectRoot,
      cacheKey: 'verified-project-and-host-binding',
      config: {
        remoteRoot: projectRoot,
        canonicalRoot: projectRoot,
        connect: async () => {
          throw new Error('A real SSH connection must not be opened')
        }
      }
    }
    const project: Project = {
      id: projectId,
      name: 'Remote test',
      location: { kind: 'ssh', hostProfileId, remoteRoot: projectRoot, canonicalRoot: projectRoot },
      workingDirectory: projectRoot,
      workingDirectoryRealPath: projectRoot,
      permissionMode: 'ask',
      pathAvailable: true,
      createdAt: '2026-10-21T00:00:00.000Z'
    }
    const session = createPhiSession({
      kind: 'project',
      projectId,
      projectLocation: project.location,
      cwd: join(directory, 'anchor'),
      cwdRealPath: join(directory, 'anchor'),
      permissionMode: 'ask'
    })
    const scope = {
      hostProfileId,
      bindingHash: remoteWorkspaceBindingHash(binding),
      projectId,
      projectRoot,
      runtimeRoot: join(realpathSync(directory), 'remote-runtime')
    }
    beginRuntimeReferenceAdoption(session.sessionId, scope, 'delete-proof').adopt({
      ...scope,
      kind: 'remote-omp',
      version: 1,
      durableSessionKey: remoteOmpDurableSessionKey(scope, session.sessionId),
      ompSessionId: 'omp-delete-1',
      journalBasename: 'omp-delete-1.jsonl',
      ompVersion: '18.10.3',
      checkpoint: { leafId: 'entry-1', verifiedAt: '2026-10-21T00:00:00.000Z' }
    })
    await run({ sessionId: session.sessionId, project, binding })
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
}

test('remote deletion verifies exact server identity, both writer locks, and omits checkpoint bytes', async () => {
  await fixture(async ({ sessionId, project, binding }) => {
    const reference = findPhiSessionById(sessionId)?.runtimeRef
    assert.ok(reference)
    const scope = {
      hostProfileId: reference.hostProfileId,
      bindingHash: reference.bindingHash,
      projectId: reference.projectId,
      projectRoot: reference.projectRoot,
      runtimeRoot: reference.runtimeRoot,
      phiSessionId: sessionId
    }
    const verify = buildRemoteSessionDeleteCommand(scope, reference, 'verify')
    const remove = buildRemoteSessionDeleteCommand(scope, reference)
    assert.match(verify, /PHI_STORAGE_SESSION_VERIFIED/)
    assert.doesNotMatch(verify, /rm -rf --/)
    assert.match(remove, /flock -x -n 9/)
    assert.match(remove, /flock -x -n 8/)
    assert.match(remove, /cmp -s -/)
    assert.match(remove, /perl -MJSON::PP/)
    assert.match(remove, /mv --/)
    assert.match(remove, /exec 8>&-/)
    assert.match(remove, /exec 9>&-/)
    assert.match(remove, /rm -rf --/)
    assert.doesNotMatch(remove, /checkpoint/)
    assert.match(remove, new RegExp(reference.durableSessionKey.replace('/', '\\/')))
    assert.equal(project.id, binding.projectId)
  })
})

test('kernel deletion verifies first and removes only its validated persistent session directory', () => {
  const reference: KernelRemoteRuntimeRef = {
    kind: 'phi-kernel',
    version: 1,
    kernelSessionId: 'kernel-session-1',
    host: {
      kind: 'ssh',
      hostProfileId: 'ssh-config:test',
      projectId: 'project-1',
      projectRoot: '/srv/project',
      runtimeRoot: '/srv/runtime',
      home: '/srv/runtime/kernel-home',
      agentDir: '/srv/runtime/kernel-home/agent'
    }
  }
  const verify = buildRemoteKernelSessionDeleteCommand(reference, 'verify')
  const remove = buildRemoteKernelSessionDeleteCommand(reference)
  assert.match(verify, /PHI_STORAGE_SESSION_VERIFIED/u)
  assert.ok(verify.indexOf("if [ 'verify' = verify ]") < verify.lastIndexOf('mv -- "$target"'))
  assert.match(
    remove,
    /\/srv\/runtime\/kernel-home\/agent\/phi-kernel\/sessions\/kernel-session-1/u
  )
  assert.match(remove, /flock -n 9/u)
  assert.match(remove, /mv --/u)
  assert.match(remove, /rm -rf --/u)
  assert.doesNotMatch(remove, /\bkill\b/u)
})

test('server command deletes only its exact scoped session directory', async () => {
  await fixture(async ({ sessionId }) => {
    const reference = findPhiSessionById(sessionId)?.runtimeRef
    assert.ok(reference)
    const scope = {
      hostProfileId: reference.hostProfileId,
      bindingHash: reference.bindingHash,
      projectId: reference.projectId,
      projectRoot: reference.projectRoot,
      runtimeRoot: reference.runtimeRoot,
      phiSessionId: sessionId
    }
    const paths = deriveRemoteSessionPaths(scope)
    for (const path of [
      scope.projectRoot,
      scope.runtimeRoot,
      join(scope.runtimeRoot, 'omp-sessions'),
      join(scope.runtimeRoot, 'omp-sessions', paths.scopeHash),
      paths.directory,
      paths.journals,
      paths.data,
      join(paths.data, 'omp'),
      paths.blobs
    ])
      mkdirSync(path, { recursive: true, mode: 0o700 })
    const serverReference = {
      ...scope,
      kind: reference.kind,
      version: reference.version,
      durableSessionKey: reference.durableSessionKey,
      ompVersion: reference.ompVersion,
      ompSessionId: reference.ompSessionId,
      journalBasename: reference.journalBasename
    }
    const preparation = {
      scope,
      paths,
      lease: {
        signal: new AbortController().signal,
        lost: new Promise<never>(() => undefined),
        assertActive: () => undefined,
        release: async () => undefined
      }
    }
    writeFileSync(paths.manifest, serializeRemoteSessionManifest(preparation, serverReference), {
      mode: 0o600
    })
    writeFileSync(paths.lock, '', { mode: 0o600 })
    writeFileSync(paths.runLock, '', { mode: 0o600 })
    const journal = join(paths.journals, reference.journalBasename)
    const validHeader = `${JSON.stringify({
      type: 'session',
      version: 3,
      id: reference.ompSessionId,
      cwd: scope.projectRoot,
      timestamp: '2026-10-21T00:00:00.000Z'
    })}\n`
    writeFileSync(journal, validHeader, { mode: 0o600 })
    const sibling = join(scope.runtimeRoot, 'omp-sessions', paths.scopeHash, 'unrelated')
    mkdirSync(sibling, { mode: 0o700 })
    writeFileSync(join(sibling, 'keep.txt'), 'keep', { mode: 0o600 })
    const sharedNatives = join(scope.runtimeRoot, 'omp-natives', reference.ompVersion)
    mkdirSync(sharedNatives, { recursive: true, mode: 0o700 })
    writeFileSync(join(sharedNatives, 'pi_natives.node'), 'shared', { mode: 0o700 })
    const bin = join(scope.runtimeRoot, 'test-bin')
    mkdirSync(bin, { mode: 0o700 })
    const flock = join(bin, 'flock')
    writeFileSync(flock, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    chmodSync(flock, 0o700)
    const run = (mode: 'verify' | 'delete'): string =>
      execFileSync('/bin/sh', ['-c', buildRemoteSessionDeleteCommand(scope, reference, mode)], {
        cwd: scope.runtimeRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
      })
    assert.equal(run('verify'), 'PHI_STORAGE_SESSION_VERIFIED\n')
    assert.ok(existsSync(paths.directory))
    const staleTombstone = `${paths.directory}.deleting-stale`
    mkdirSync(staleTombstone, { mode: 0o700 })
    assert.throws(() => run('verify'), /Command failed/)
    rmSync(staleTombstone, { recursive: true })
    writeFileSync(journal, validHeader.replace(reference.ompSessionId, 'different-session'))
    assert.throws(() => run('delete'), /Command failed/)
    assert.ok(existsSync(paths.directory), 'a changed journal cannot be removed')
    writeFileSync(journal, validHeader)
    assert.equal(run('delete'), 'PHI_STORAGE_SESSION_DELETED\n')
    assert.equal(existsSync(paths.directory), false)
    assert.equal(readFileSync(join(sibling, 'keep.txt'), 'utf8'), 'keep')
    assert.equal(readFileSync(join(sharedNatives, 'pi_natives.node'), 'utf8'), 'shared')
  })
})

test('remote deletion keeps local history when the server is offline or rejects identity', async () => {
  await fixture(async ({ sessionId, project, binding }) => {
    let calls = 0
    const dependencies = {
      getProject: () => project,
      resolveBinding: () => binding,
      connect: async () => ({
        exec: async () => {
          throw new Error('unused')
        },
        execBounded: async () => {
          calls += 1
          return {
            stdout: '',
            stderr: 'PHI_STORAGE:IDENTITY_MISMATCH',
            code: 1,
            signal: null,
            stdoutTruncated: false,
            stderrTruncated: false
          }
        },
        close: async () => undefined
      }),
      releaseSession: async () => undefined
    }
    await assert.rejects(prepareRemotePhiDeletion(sessionId, dependencies), /校验失败/)
    assert.equal(calls, 1)
    assert.ok(findPhiSessionById(sessionId))
    await assert.rejects(
      prepareRemotePhiDeletion(sessionId, {
        ...dependencies,
        connect: async () => {
          throw new Error('SSH offline')
        }
      }),
      RemoteSessionDeleteUnavailableError
    )
    assert.ok(findPhiSessionById(sessionId))
    await assert.rejects(
      prepareRemotePhiDeletion(sessionId, {
        ...dependencies,
        connect: async () => ({
          exec: async () => {
            throw new Error('unused')
          },
          execBounded: async () => ({
            stdout: '',
            stderr: '',
            code: 1,
            signal: null,
            stdoutTruncated: false,
            stderrTruncated: false
          }),
          close: async () => undefined
        })
      }),
      RemoteSessionDeleteUnavailableError
    )
    assert.ok(findPhiSessionById(sessionId))
  })
})

test('remote deletion removes the local index only after confirmed server deletion', async () => {
  await fixture(async ({ sessionId, project, binding }) => {
    let calls = 0
    let closed = 0
    let released = 0
    const dependencies = {
      getProject: () => project,
      resolveBinding: () => binding,
      connect: async () => ({
        exec: async () => {
          throw new Error('unused')
        },
        execBounded: async () => ({
          stdout:
            ++calls === 1 ? 'PHI_STORAGE_SESSION_VERIFIED\n' : 'PHI_STORAGE_SESSION_DELETED\n',
          stderr: '',
          code: 0,
          signal: null,
          stdoutTruncated: false,
          stderrTruncated: false
        }),
        close: async () => {
          closed += 1
        }
      }),
      releaseSession: async () => {
        released += 1
      }
    }
    const prepared = await prepareRemotePhiDeletion(sessionId, dependencies)
    assert.ok(findPhiSessionById(sessionId), 'read-only preflight keeps local data')
    await prepared.delete()
    await prepared.close()
    assert.equal(calls, 2)
    assert.equal(closed, 1)
    assert.equal(released, 1)
    assert.equal(findPhiSessionById(sessionId), null)
  })
})

test('a server failure after preflight leaves Phi history available for retry', async () => {
  await fixture(async ({ sessionId, project, binding }) => {
    let calls = 0
    const prepared = await prepareRemotePhiDeletion(sessionId, {
      getProject: () => project,
      resolveBinding: () => binding,
      connect: async () => ({
        exec: async () => {
          throw new Error('unused')
        },
        execBounded: async () => ({
          stdout: ++calls === 1 ? 'PHI_STORAGE_SESSION_VERIFIED\n' : '',
          stderr: calls === 1 ? '' : 'PHI_STORAGE:SESSION_BUSY',
          code: calls === 1 ? 0 : 1,
          signal: null,
          stdoutTruncated: false,
          stderrTruncated: false
        }),
        close: async () => undefined
      }),
      releaseSession: async () => undefined
    })
    await assert.rejects(prepared.delete(), /仍在运行/)
    await prepared.close()
    assert.equal(calls, 2)
    assert.ok(findPhiSessionById(sessionId))
  })
})

test('a dropped SSH connection during deletion retains the local session', async () => {
  await fixture(async ({ sessionId, project, binding }) => {
    let calls = 0
    const prepared = await prepareRemotePhiDeletion(sessionId, {
      getProject: () => project,
      resolveBinding: () => binding,
      connect: async () => ({
        exec: async () => {
          throw new Error('unused')
        },
        execBounded: async () => {
          if (++calls === 2) throw new Error('SSH connection lost before deletion was confirmed')
          return {
            stdout: 'PHI_STORAGE_SESSION_VERIFIED\n',
            stderr: '',
            code: 0,
            signal: null,
            stdoutTruncated: false,
            stderrTruncated: false
          }
        },
        close: async () => undefined
      }),
      releaseSession: async () => undefined
    })
    await assert.rejects(prepared.delete(), RemoteSessionDeleteUnavailableError)
    await prepared.close()
    assert.equal(calls, 2)
    assert.ok(findPhiSessionById(sessionId))
  })
})

test('every session whose history is on a server deletes there, whichever route created it', () => {
  const host = (kind: 'ssh' | 'local'): { host: { kind: 'ssh' | 'local' } } => ({ host: { kind } })
  const check = (manifest: object): boolean => deletesOnServer(manifest as never)
  assert.equal(check({ kernelRuntimeRef: host('ssh') }), true)
  assert.equal(check({ runtimeRef: {} }), true)
  assert.equal(check({ runtimeRecoveryError: {} }), true)
  assert.equal(check({ kernelRuntimeRef: host('local') }), false)
  assert.equal(check({}), false)
})

test('kernel deletion runs from any directory and removes the session the kernel stored', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-kernel-delete-')))
  try {
    const runtimeRoot = join(root, 'runtime')
    const agentDir = join(runtimeRoot, 'kernel-home', 'agent')
    const sessions = join(agentDir, 'phi-kernel', 'sessions')
    const target = join(sessions, 'kernel-session-1')
    const sibling = join(sessions, 'kernel-session-2')
    mkdirSync(target, { recursive: true, mode: 0o700 })
    mkdirSync(sibling, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    chmodSync(runtimeRoot, 0o700)
    writeFileSync(join(target, 'journal.jsonl'), '{}\n')
    // These stand in for Linux coreutils, which the server has and a Mac test host doesn't.
    const bin = join(root, 'bin')
    mkdirSync(bin, { mode: 0o700 })
    writeFileSync(join(bin, 'stat'), '#!/bin/sh\ncase "$2" in %u) id -u ;; *) echo 700 ;; esac\n', {
      mode: 0o700
    })
    const reference: KernelRemoteRuntimeRef = {
      kind: 'phi-kernel',
      version: 1,
      kernelSessionId: 'kernel-session-1',
      host: {
        kind: 'ssh',
        hostProfileId: 'ssh-config:test',
        projectId: 'project-1',
        projectRoot: join(root, 'project'),
        runtimeRoot,
        home: join(runtimeRoot, 'kernel-home'),
        agentDir
      }
    }
    const run = (mode: 'verify' | 'delete'): string =>
      execFileSync('/bin/sh', ['-c', buildRemoteKernelSessionDeleteCommand(reference, mode)], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
      })
    assert.equal(run('verify'), 'PHI_STORAGE_SESSION_VERIFIED\n')
    assert.ok(existsSync(target), 'verifying leaves the session in place')
    assert.equal(run('delete'), 'PHI_STORAGE_SESSION_DELETED\n')
    assert.equal(existsSync(target), false)
    assert.ok(existsSync(sibling))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
