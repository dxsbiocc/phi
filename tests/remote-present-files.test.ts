import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validateRemotePresentedFiles } from '../src/main/agent/deliverables/remote-present-files'
import { ensureRemoteProjectAnchor } from '../src/main/agent/remote-project-anchor'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'

test('remote present_files returns SSH references without reading the local anchor', async () => {
  const anchor = mkdtempSync(join(tmpdir(), 'phi-remote-present-anchor-'))
  const sentinel = join(anchor, 'sentinel.txt')
  writeFileSync(sentinel, 'untouched')
  const inspected: string[] = []
  try {
    const files = await validateRemotePresentedFiles(
      { sessionId: 'session-1', projectId: 'project-1' },
      [{ path: 'reports/result.csv', description: '  Final\n result  ' }],
      {
        inspect: async (path) => {
          inspected.push(path)
          return {
            path: 'ssh://cluster-a/project/reports/result.csv',
            displayPath: 'reports/result.csv',
            bytes: 42,
            identity: '/project/reports/result.csv'
          }
        }
      }
    )

    assert.deepEqual(inspected, ['reports/result.csv'])
    assert.deepEqual(files, [
      {
        path: 'ssh://cluster-a/project/reports/result.csv',
        displayPath: 'reports/result.csv',
        bytes: 42,
        description: 'Final result'
      }
    ])
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched')
  } finally {
    rmSync(anchor, { recursive: true, force: true })
  }
})

test('remote present_files rejects duplicates and invalid metadata before host access', async () => {
  let inspections = 0
  const inspect = async (): Promise<{
    path: string
    displayPath: string
    bytes: number
    identity: string
  }> => {
    inspections += 1
    return {
      path: 'ssh://cluster-a/project/one.txt',
      displayPath: 'one.txt',
      bytes: 3,
      identity: '/project/one.txt'
    }
  }
  await assert.rejects(
    validateRemotePresentedFiles(
      { sessionId: 'session-1', projectId: 'project-1' },
      [{ path: 'one.txt' }, { path: './one.txt' }],
      { inspect }
    ),
    /twice/
  )
  await assert.rejects(
    validateRemotePresentedFiles(
      { sessionId: 'session-1', projectId: 'project-1' },
      [{ path: '../outside.txt' }],
      { inspect }
    ),
    /inside the remote workspace/
  )
  assert.equal(inspections, 2)
})

test('remote present_files default backend inspects only the selected server path', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-remote-present-host-'))
  const anchor = ensureRemoteProjectAnchor('project-1', agentDir)
  const sentinel = join(anchor, 'sentinel.txt')
  writeFileSync(sentinel, 'untouched')
  const location = {
    kind: 'ssh' as const,
    hostProfileId: 'profile-1',
    remoteRoot: '/remote/project',
    canonicalRoot: '/remote/project'
  }
  const commands: string[] = []
  let call = 0
  const execute = async (command: string): Promise<ReturnType<typeof result>> => {
    commands.push(command)
    call += 1
    return call === 1 ? result('/remote/project/reports/result.csv\0') : result('42\n')
  }
  const session = {
    exec: execute,
    execBounded: execute,
    async close(): Promise<void> {
      return undefined
    }
  } as unknown as RemoteSshSession
  try {
    const files = await validateRemotePresentedFiles(
      { sessionId: 'phi-session-1', projectId: 'project-1' },
      [{ path: 'reports/result.csv' }],
      {
        agentDir,
        getManifest: () =>
          ({
            kind: 'project',
            projectId: 'project-1',
            cwd: anchor,
            projectLocation: location
          }) as never,
        getProject: () => ({ id: 'project-1', location }) as never,
        getHostProfile: () => ({
          id: 'profile-1',
          label: 'Cluster',
          hostAlias: 'cluster-a'
        }),
        connectHost: async () => session
      }
    )
    assert.equal(files[0]?.path, 'ssh://cluster-a/remote/project/reports/result.csv')
    assert.equal(files[0]?.bytes, 42)
    assert.match(commands[1] ?? '', /cd -P/)
    assert.match(commands[1] ?? '', /O_NOFOLLOW/)
    assert.ok(commands.every((command) => !command.includes(anchor)))
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched')
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

function result(stdout: string): {
  stdout: string
  stderr: string
  code: number
  signal: null
  stdoutTruncated: false
  stderrTruncated: false
} {
  return {
    stdout,
    stderr: '',
    code: 0,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false
  }
}
