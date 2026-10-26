import assert from 'node:assert/strict'
import test from 'node:test'

import { probeRemoteKernelHistory } from '../src/main/agent/engine/kernel-history'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import type { RemoteOmpRuntimeRef } from '../src/main/agent/session/runtime-reference'

const reference: RemoteOmpRuntimeRef = {
  kind: 'remote-omp',
  version: 1,
  hostProfileId: 'ssh-config:test',
  bindingHash: 'a'.repeat(64),
  projectId: 'project-1',
  projectRoot: '/srv/project',
  runtimeRoot: '/srv/runtime',
  durableSessionKey: `${'b'.repeat(64)}/phi-1`,
  ompSessionId: 'omp-1',
  journalBasename: 'session.jsonl',
  ompVersion: '18.10.3'
}

const manifest = {
  schemaVersion: 1,
  sessionId: 'phi-1',
  kind: 'project',
  projectId: 'project-1',
  projectLocation: {
    kind: 'ssh',
    hostProfileId: 'ssh-config:test',
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project'
  },
  cwd: '/local/anchor',
  cwdRealPath: '/local/anchor',
  permissionMode: 'ask',
  status: 'idle',
  unreadKind: null,
  messageCount: 0,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  lastActivityAt: '2026-10-26T00:00:00.000Z'
} satisfies PhiSessionManifest

test('remote history probe proves integrity and both old locks without mutating or killing', async () => {
  const header = Buffer.from(
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: 'omp-1',
      timestamp: '2026-10-26T00:00:00.000Z',
      cwd: '/srv/project'
    })}\n`
  ).toString('base64')
  let command = ''
  const result = await probeRemoteKernelHistory(
    {
      execBounded: async (value) => {
        command = value
        return {
          stdout: `${header}\n123\n${'c'.repeat(64)}\ngone\ngone\n`,
          stderr: '',
          code: 0,
          signal: null,
          stdoutTruncated: false,
          stderrTruncated: false
        }
      }
    },
    reference,
    manifest
  )
  assert.equal(result.sourceSha256, 'c'.repeat(64))
  assert.equal(result.sourceOmpSessionId, 'omp-1')
  assert.equal(result.sourceCwd, '/srv/project')
  assert.equal(result.writer, 'gone')
  assert.equal(result.runLock, 'gone')
  assert.match(command, /flock -n/u)
  assert.doesNotMatch(command, /\bkill\b|\brm\b/u)
})

test('remote history probe preserves a held lock as read-only evidence', async () => {
  const header = Buffer.from(
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: 'omp-1',
      timestamp: '2026-10-26T00:00:00.000Z',
      cwd: '/srv/project'
    })}\n`
  ).toString('base64')
  const result = await probeRemoteKernelHistory(
    {
      execBounded: async () => ({
        stdout: `${header}\n123\n${'d'.repeat(64)}\nheld\ngone\n`,
        stderr: '',
        code: 0,
        signal: null,
        stdoutTruncated: false,
        stderrTruncated: false
      })
    },
    reference,
    manifest
  )
  assert.equal(result.writer, 'held')
})
