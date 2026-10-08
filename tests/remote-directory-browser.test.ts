import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildRemoteDirectoryListCommand,
  listRemoteProjectDirectories
} from '../src/main/agent/remote-directory-browser'
import { saveRemoteHostProfile } from '../src/main/agent/remote-hosts'
import type {
  RemoteExecBoundedResult,
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'

function fixture(): {
  agentDir: string
  root: string
  hostProfileId: string
  commands: string[]
  connectImpl: () => Promise<RemoteSshSession>
  setResult: (result: RemoteExecResult | Error | undefined) => void
  closed: () => number
  connections: () => number
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-directory-browser-'))
  const agentDir = join(base, 'phi')
  const root = join(base, "remote project's directory")
  mkdirSync(root)
  const profile = saveRemoteHostProfile({ label: 'Cluster', hostAlias: 'cluster-one' }, agentDir)
  let closeCount = 0
  let connectionCount = 0
  let response: RemoteExecResult | Error | undefined
  const commands: string[] = []
  return {
    agentDir,
    root,
    hostProfileId: profile.id,
    commands,
    setResult: (result) => {
      response = result
    },
    closed: () => closeCount,
    connections: () => connectionCount,
    connectImpl: async () => {
      connectionCount += 1
      return {
        exec: async (command) => {
          commands.push(command)
          if (response instanceof Error) throw response
          if (response) return response
          const result = spawnSync('sh', ['-c', command], {
            encoding: 'utf-8',
            timeout: 3_000,
            maxBuffer: 1024 * 1024
          })
          if (result.error) throw result.error
          return {
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            code: result.status,
            signal: result.signal
          }
        },
        readTextFile: async () => {
          throw new Error('file reads must not be used')
        },
        writeTextFile: async () => {
          throw new Error('writes must not be used')
        },
        mkdirp: async () => {
          throw new Error('writes must not be used')
        },
        exists: async () => {
          throw new Error('extra probes must not be used')
        },
        uploadFile: async () => {
          throw new Error('uploads must not be used')
        },
        close: async () => {
          closeCount += 1
        }
      }
    },
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

function success(stdout: string): RemoteExecResult {
  return { stdout, stderr: '', code: 0, signal: null }
}

test('pre-project listing returns only directories and preserves NUL-separated names', async () => {
  const sample = fixture()
  try {
    const names = ['normal', '.hidden', '..extra', "quote' and space", 'line\nbreak', '$(echo bad)']
    for (const name of names) mkdirSync(join(sample.root, name))
    writeFileSync(join(sample.root, 'ordinary.txt'), 'not a directory')
    symlinkSync(join(sample.root, 'normal'), join(sample.root, 'linked-directory'))
    const listing = await listRemoteProjectDirectories(
      { hostProfileId: sample.hostProfileId, path: sample.root },
      sample
    )
    const path = realpathSync(sample.root)
    assert.equal(listing.hostProfileId, sample.hostProfileId)
    assert.equal(listing.path, path)
    assert.equal(listing.truncated, false)
    assert.deepEqual(
      new Set(listing.directories.map((entry) => entry.name)),
      new Set([...names, 'linked-directory'])
    )
    assert.ok(listing.directories.every((entry) => entry.path === `${path}/${entry.name}`))
    assert.equal(sample.commands.length, 1)
    assert.equal(sample.closed(), 1)
  } finally {
    sample.cleanup()
  }
})

test('root and empty directories are valid browse targets', async () => {
  const sample = fixture()
  try {
    const empty = await listRemoteProjectDirectories(
      { hostProfileId: sample.hostProfileId, path: sample.root },
      sample
    )
    assert.deepEqual(empty.directories, [])
    const root = await listRemoteProjectDirectories(
      { hostProfileId: sample.hostProfileId, path: '/' },
      sample
    )
    assert.equal(root.path, '/')
    assert.ok(root.directories.length > 0)
    assert.ok(root.directories.every((entry) => entry.path === `/${entry.name}`))
    assert.equal(sample.closed(), 2)
  } finally {
    sample.cleanup()
  }
})

test('invalid and relative requests are rejected before opening SSH', async () => {
  const sample = fixture()
  try {
    const invalid = [
      undefined,
      null,
      [],
      'bad',
      {},
      { hostProfileId: sample.hostProfileId, path: 'relative' },
      { hostProfileId: sample.hostProfileId, path: '~/' },
      { hostProfileId: sample.hostProfileId, path: '/nul\0path' },
      { hostProfileId: sample.hostProfileId, path: `/${'x'.repeat(4096)}` },
      { hostProfileId: '', path: '/' },
      { hostProfileId: ' host ', path: '/' },
      { hostProfileId: 'host\nname', path: '/' },
      { hostProfileId: sample.hostProfileId, path: '/', command: 'anything' }
    ]
    for (const input of invalid) await assert.rejects(listRemoteProjectDirectories(input, sample))
    assert.throws(() => buildRemoteDirectoryListCommand('relative'), /绝对路径/)
    assert.equal(sample.connections(), 0)
    assert.equal(sample.closed(), 0)
  } finally {
    sample.cleanup()
  }
})

test('unknown hosts and SSH connection failures never browse locally', async () => {
  const sample = fixture()
  try {
    await assert.rejects(
      listRemoteProjectDirectories({ hostProfileId: 'missing', path: sample.root }, sample),
      /服务器档案不存在/
    )
    assert.equal(sample.connections(), 0)
    await assert.rejects(
      listRemoteProjectDirectories(
        { hostProfileId: sample.hostProfileId, path: sample.root },
        {
          agentDir: sample.agentDir,
          connectImpl: async () => {
            throw new Error('SSH offline')
          }
        }
      ),
      /SSH offline/
    )
    assert.equal(sample.commands.length, 0)
    assert.equal(sample.closed(), 0)
  } finally {
    sample.cleanup()
  }
})

test('malformed and oversized records fail closed and always close SSH', async () => {
  const sample = fixture()
  const malformed = [
    '',
    'banner\nphi-directory-list-v1\0/\0\x000\0',
    'phi-directory-list-v1\0relative\0\x000\0',
    'phi-directory-list-v1\0/a/../b\0\x000\0',
    'phi-directory-list-v1\0/\0nested/path\0\x000\0',
    'phi-directory-list-v1\0/\0..\0\x000\0',
    'phi-directory-list-v1\0/\0same\0same\0\x000\0',
    'phi-directory-list-v1\0/\0broken\uFFFDname\0\x000\0',
    'phi-directory-list-v1\0/\0\0no\0',
    'phi-directory-list-v1\0/\0\x000',
    'x'.repeat(1024 * 1024 + 1)
  ]
  try {
    for (const stdout of malformed) {
      sample.setResult(success(stdout))
      await assert.rejects(
        listRemoteProjectDirectories({ hostProfileId: sample.hostProfileId, path: '/' }, sample),
        /格式无效|大小限制/
      )
    }
    assert.equal(sample.closed(), malformed.length)
  } finally {
    sample.cleanup()
  }
})

test('missing directories and execution failures close SSH', async () => {
  const sample = fixture()
  try {
    await assert.rejects(
      listRemoteProjectDirectories(
        { hostProfileId: sample.hostProfileId, path: join(sample.root, 'missing') },
        sample
      ),
      /无法读取远程目录/
    )
    sample.setResult(new Error('SSH interrupted'))
    await assert.rejects(
      listRemoteProjectDirectories({ hostProfileId: sample.hostProfileId, path: '/' }, sample),
      /SSH interrupted/
    )
    assert.equal(sample.closed(), 2)
  } finally {
    sample.cleanup()
  }
})

test('directory cap reports truncation without returning partial NUL records', async () => {
  const sample = fixture()
  try {
    for (let index = 0; index < 1001; index += 1) mkdirSync(join(sample.root, `dir-${index}`))
    const listing = await listRemoteProjectDirectories(
      { hostProfileId: sample.hostProfileId, path: sample.root },
      sample
    )
    assert.equal(listing.directories.length, 1000)
    assert.equal(listing.truncated, true)
    assert.equal(sample.closed(), 1)
  } finally {
    sample.cleanup()
  }
})

test('transport bounds output and rejects truncated output before parsing', async () => {
  const sample = fixture()
  try {
    const session = await sample.connectImpl()
    session.execBounded = async (_, options): Promise<RemoteExecBoundedResult> => {
      assert.equal(options.maxOutputBytes, 1024 * 1024)
      assert.equal(options.timeoutMs, 5000)
      return { ...success('partial'), stdoutTruncated: true, stderrTruncated: false }
    }
    await assert.rejects(
      listRemoteProjectDirectories(
        { hostProfileId: sample.hostProfileId, path: '/' },
        { agentDir: sample.agentDir, connectImpl: async () => session }
      ),
      /大小限制/
    )
    assert.equal(sample.closed(), 1)
  } finally {
    sample.cleanup()
  }
})
