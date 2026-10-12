import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RemoteWorkspaceHostRegistry } from '../src/main/agent/workspace-host/remote-registry'
import type { RemoteWorkspaceHostBinding } from '../src/main/agent/remote-workspace-boundary'
import { createLocalShellSession } from './helpers/localShellSession'
import { assertBoundaryIdentity } from './helpers/remoteBoundaryIdentity'

function fixture(options: { now?: () => number; ttlMs?: number } = {}): {
  base: string
  root: string
  session: ReturnType<typeof createLocalShellSession>
  registry: RemoteWorkspaceHostRegistry
  request(paths: string[]): { sessionId: string; projectId: string; paths: string[] }
  cleanup(): void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-remote-path-probe-'))
  const root = join(base, 'project')
  mkdirSync(root)
  const canonicalRoot = realpathSync(root)
  const session = createLocalShellSession(canonicalRoot)
  const binding = (
    sessionId = 'session-a',
    projectId = 'project-a'
  ): RemoteWorkspaceHostBinding => ({
    sessionId,
    projectId,
    hostAlias: 'cluster-a',
    remoteRoot: canonicalRoot,
    canonicalRoot,
    cacheKey: 'cluster-a:project-a',
    config: {
      remoteRoot: canonicalRoot,
      canonicalRoot,
      connect: async () => session
    }
  })
  const registry = new RemoteWorkspaceHostRegistry({
    resolveBinding: (request) => {
      assertBoundaryIdentity(request)
      return binding(request.sessionId, request.projectId)
    },
    now: options.now,
    pathStatTtlMs: options.ttlMs
  })
  return {
    base,
    root: canonicalRoot,
    session,
    registry,
    request(paths: string[]) {
      return { sessionId: 'session-a', projectId: 'project-a', paths }
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true })
    }
  }
}

test('remote path probe batches file, directory and missing stats into one SSH command', async () => {
  const f = fixture()
  try {
    const directory = join(f.root, 'wrappers', 'runs', 'wrun_a')
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'params.json')
    const missing = join(f.root, 'params.json')
    writeFileSync(file, '{}')

    assert.deepEqual(await f.registry.statPaths(f.request([file, directory, missing])), [
      { path: file, kind: 'file' },
      { path: directory, kind: 'directory' },
      { path: missing, kind: 'missing' }
    ])
    assert.equal(f.session.commands.length, 1)
    assert.match(f.session.commands[0] ?? '', /perl/)
  } finally {
    f.cleanup()
  }
})

test('remote path probe caches every kind for a short TTL', async () => {
  let now = 10_000
  const f = fixture({ now: () => now, ttlMs: 2_000 })
  try {
    const path = join(f.root, 'later.txt')
    assert.deepEqual(await f.registry.statPaths(f.request([path])), [{ path, kind: 'missing' }])
    writeFileSync(path, 'ready')

    now += 1_000
    assert.deepEqual(await f.registry.statPaths(f.request([path])), [{ path, kind: 'missing' }])
    assert.equal(f.session.commands.length, 1)

    now += 1_001
    assert.deepEqual(await f.registry.statPaths(f.request([path])), [{ path, kind: 'file' }])
    assert.equal(f.session.commands.length, 2)
  } finally {
    f.cleanup()
  }
})

test('remote path probe strictly rejects undeclared fields and unsafe batches', async () => {
  const f = fixture()
  try {
    const valid = join(f.root, 'valid.txt')
    const invalid: unknown[] = [
      { ...f.request([valid]), i: 0 },
      f.request([`${f.root}/bad\0name.txt`]),
      { ...f.request([valid]), paths: [valid, 42] },
      f.request(['relative.txt']),
      f.request([`${f.root}/dir/../valid.txt`]),
      f.request([join(f.base, 'outside.txt')]),
      f.request([`${f.root}/${'x'.repeat(4097)}`]),
      f.request(Array.from({ length: 65 }, (_, index) => join(f.root, `${index}.txt`)))
    ]
    for (const request of invalid) await assert.rejects(f.registry.statPaths(request))
    assert.equal(f.session.commands.length, 0)
  } finally {
    f.cleanup()
  }
})

test('remote path probe reports a symlink escaping the project as missing', async () => {
  const f = fixture()
  try {
    const outside = join(f.base, 'outside.txt')
    const link = join(f.root, 'outside-link.txt')
    writeFileSync(outside, 'secret')
    symlinkSync(outside, link)

    assert.deepEqual(await f.registry.statPaths(f.request([link])), [
      { path: link, kind: 'missing' }
    ])
    assert.equal(f.session.commands.length, 1)
  } finally {
    f.cleanup()
  }
})
