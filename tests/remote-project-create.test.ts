import assert from 'node:assert/strict'
import test from 'node:test'

import { createCheckedRemoteProject } from '../src/main/agent/remote-project-create'
import type { Project } from '../src/main/agent/projects'
import type { RemoteDoctorCheck, RemoteDoctorReport } from '../src/shared/remoteDoctorTypes'

const input = {
  name: 'Cluster project',
  hostProfileId: 'host-1',
  remoteRoot: '/cluster/project',
  permissionMode: 'ask' as const
}

const workspaceChecks: RemoteDoctorCheck[] = [
  'ssh',
  'sftp',
  'path',
  'path_read',
  'path_write',
  'shell'
].map((id) => ({ id, status: 'ok', message: `${id} ok` }))

function doctorReport(checks = workspaceChecks): RemoteDoctorReport {
  return {
    hostProfileId: input.hostProfileId,
    checkedAt: '2026-09-24T00:00:00.000Z',
    ok: checks.every((check) => check.status !== 'error'),
    checks
  }
}

test('remote project creation verifies the workspace and leaves software checks optional', async () => {
  const calls: string[] = []
  const project = { id: 'remote-1' } as Project
  const created = await createCheckedRemoteProject(input, {
    doctorImpl: async (hostProfileId, remoteRoot, options) => {
      calls.push(`doctor:${hostProfileId}:${remoteRoot}:${options?.scope}`)
      return doctorReport([
        ...workspaceChecks,
        { id: 'nextflow', status: 'error', message: 'Nextflow not installed' }
      ])
    },
    createImpl: async (value) => {
      calls.push(`create:${value.hostProfileId}:${value.remoteRoot}`)
      return project
    }
  })
  assert.equal(created, project)
  assert.deepEqual(calls, [
    'doctor:host-1:/cluster/project:workspace',
    'create:host-1:/cluster/project'
  ])
})

test('connection or directory permission failures cannot register a project', async () => {
  for (const failedId of ['ssh', 'path', 'path_read', 'path_write', 'shell']) {
    let creates = 0
    const checks = workspaceChecks.map((check) =>
      check.id === failedId
        ? {
            ...check,
            status: 'error' as const,
            message: `${failedId} failed`,
            suggestion: 'Fix setting'
          }
        : check
    )
    await assert.rejects(
      () =>
        createCheckedRemoteProject(input, {
          doctorImpl: async () => doctorReport(checks),
          createImpl: async () => {
            creates += 1
            return {} as Project
          }
        }),
      new RegExp(`${failedId} failed`)
    )
    assert.equal(creates, 0, failedId)
  }
})

test('missing checks and malformed inputs fail before the registry is written', async () => {
  let creates = 0
  await assert.rejects(
    () =>
      createCheckedRemoteProject(input, {
        doctorImpl: async () =>
          doctorReport(workspaceChecks.filter((check) => check.id !== 'path_write')),
        createImpl: async () => {
          creates += 1
          return {} as Project
        }
      }),
    /检查未完成/
  )
  await assert.rejects(
    () =>
      createCheckedRemoteProject(
        { ...input, hostProfileId: '' },
        {
          doctorImpl: async () => {
            throw new Error('doctor must not run')
          },
          createImpl: async () => {
            creates += 1
            return {} as Project
          }
        }
      ),
    /设置无效/
  )
  assert.equal(creates, 0)
})

test('remote canonical-path duplicate errors remain visible to the creation flow', async () => {
  await assert.rejects(
    () =>
      createCheckedRemoteProject(input, {
        doctorImpl: async () => doctorReport(),
        createImpl: async () => {
          throw new Error('该服务器上的项目目录已存在')
        }
      }),
    /已存在/
  )
})
