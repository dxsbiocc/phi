import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  DEFAULT_REMOTE_RUNTIME_ROOT,
  normalizeRemoteRuntimeRoot,
  resolveRemoteRuntimeRoot
} from '../src/main/agent/remote-runtime-root'
import {
  readHostRuntimeRoot,
  remoteRuntimeRootStorePath,
  saveHostRuntimeRoot
} from '../src/main/agent/remote-runtime-root-store'

const temporaryDirectories: string[] = []

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'phi-remote-runtime-root-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('remote runtime root values', () => {
  it('normalizes absolute and home-relative roots without changing their spelling', () => {
    assert.equal(normalizeRemoteRuntimeRoot('/data/scientist/phi///'), '/data/scientist/phi')
    assert.equal(normalizeRemoteRuntimeRoot('/'), '/')
    assert.equal(normalizeRemoteRuntimeRoot('////'), '/')
    assert.equal(normalizeRemoteRuntimeRoot('~/.phi/runtime/'), '~/.phi/runtime')
    assert.equal(normalizeRemoteRuntimeRoot('~/'), '~/')
    assert.equal(normalizeRemoteRuntimeRoot('~///'), '~/')
  })

  it('rejects empty, non-absolute, unsafe, and multiline roots', () => {
    for (const value of ['', 'relative/path', '~', '../runtime', '/data/../runtime']) {
      assert.throws(() => normalizeRemoteRuntimeRoot(value))
    }
    assert.throws(() => normalizeRemoteRuntimeRoot('/data/bad\0root'))
    assert.throws(() => normalizeRemoteRuntimeRoot('/data/bad\nroot'))
    assert.throws(() => normalizeRemoteRuntimeRoot('/data/bad\rroot'))
  })

  it('resolves project, host, and default roots in priority order', () => {
    assert.deepEqual(
      resolveRemoteRuntimeRoot({
        projectOverride: '/project/runtime/',
        hostOverride: '/host/runtime/'
      }),
      { source: 'project', configured: '/project/runtime' }
    )
    assert.deepEqual(resolveRemoteRuntimeRoot({ hostOverride: '~/host-runtime/' }), {
      source: 'host',
      configured: '~/host-runtime'
    })
    assert.deepEqual(resolveRemoteRuntimeRoot({}), {
      source: 'default',
      configured: DEFAULT_REMOTE_RUNTIME_ROOT
    })
  })

  it('treats undefined and null overrides as cleared values', () => {
    assert.deepEqual(
      resolveRemoteRuntimeRoot({ projectOverride: null, hostOverride: '/host/runtime' }),
      { source: 'host', configured: '/host/runtime' }
    )
    assert.deepEqual(resolveRemoteRuntimeRoot({ projectOverride: undefined, hostOverride: null }), {
      source: 'default',
      configured: DEFAULT_REMOTE_RUNTIME_ROOT
    })
  })
})

describe('remote runtime root host store', () => {
  it('persists normalized overrides per host profile with an atomic private file', () => {
    const agentDir = makeTempDir()

    saveHostRuntimeRoot('ssh-config:GPU', '/data/scientist/runtime///', agentDir)
    saveHostRuntimeRoot('profile:hpc', '~/.phi/alternate/', agentDir)

    assert.equal(readHostRuntimeRoot('ssh-config:GPU', agentDir), '/data/scientist/runtime')
    assert.equal(readHostRuntimeRoot('profile:hpc', agentDir), '~/.phi/alternate')
    const path = remoteRuntimeRootStorePath(agentDir)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(
      readdirSync(agentDir).filter((name) => name.includes('.tmp')),
      []
    )
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))), ['version', 'entries'])
  })

  it('atomically replaces an existing lax-permission file and preserves other hosts', () => {
    const agentDir = makeTempDir()
    saveHostRuntimeRoot('host:a', '/runtime/a', agentDir)
    chmodSync(remoteRuntimeRootStorePath(agentDir), 0o644)

    saveHostRuntimeRoot('host:b', '/runtime/b', agentDir)

    assert.equal(readHostRuntimeRoot('host:a', agentDir), '/runtime/a')
    assert.equal(readHostRuntimeRoot('host:b', agentDir), '/runtime/b')
    assert.equal(statSync(remoteRuntimeRootStorePath(agentDir)).mode & 0o777, 0o600)
  })

  it('clears one host override without affecting another or the default fallback', () => {
    const agentDir = makeTempDir()
    saveHostRuntimeRoot('host:a', '/runtime/a', agentDir)
    saveHostRuntimeRoot('host:b', '/runtime/b', agentDir)

    saveHostRuntimeRoot('host:a', null, agentDir)

    assert.equal(readHostRuntimeRoot('host:a', agentDir), undefined)
    assert.equal(readHostRuntimeRoot('host:b', agentDir), '/runtime/b')
    assert.deepEqual(
      resolveRemoteRuntimeRoot({ hostOverride: readHostRuntimeRoot('host:a', agentDir) }),
      {
        source: 'default',
        configured: DEFAULT_REMOTE_RUNTIME_ROOT
      }
    )
  })

  it('ignores invalid documents and invalid entries while retaining valid entries', () => {
    const agentDir = makeTempDir()
    const path = remoteRuntimeRootStorePath(agentDir)

    writeFileSync(path, '{broken')
    assert.equal(readHostRuntimeRoot('host:a', agentDir), undefined)

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: {
          'host:a': '/valid/runtime/',
          'host:b': '../invalid',
          'host:c': 42,
          'host:d': '/invalid/../runtime'
        }
      })
    )
    assert.equal(readHostRuntimeRoot('host:a', agentDir), '/valid/runtime')
    assert.equal(readHostRuntimeRoot('host:b', agentDir), undefined)
    assert.equal(readHostRuntimeRoot('host:c', agentDir), undefined)
    assert.equal(readHostRuntimeRoot('host:d', agentDir), undefined)
  })

  it('rejects invalid host profile identifiers and invalid values before writing', () => {
    const agentDir = makeTempDir()
    assert.throws(() => saveHostRuntimeRoot('', '/runtime', agentDir))
    assert.throws(() => saveHostRuntimeRoot('host\nother', '/runtime', agentDir))
    assert.throws(() => saveHostRuntimeRoot('host:a', 'relative/runtime', agentDir))
  })
})
