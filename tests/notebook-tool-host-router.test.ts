import assert from 'node:assert/strict'
import test from 'node:test'

import { NotebookToolHostRouter } from '../src/main/agent/notebook/notebook-tool-host-router'
import type { NotebookToolRequest } from '../src/main/agent/notebook/notebook-tools'

const localRequest: NotebookToolRequest = { action: 'list', cwd: '/local/project', params: {} }
const remoteIdentity = {
  runtimeSessionId: 'runtime-1',
  sessionId: 'phi-session-1',
  projectId: 'project-1'
}

test('notebook host router sends verified remote requests only to the remote backend', async () => {
  const calls: Array<{ backend: string; request: NotebookToolRequest }> = []
  const router = new NotebookToolHostRouter({
    local: async (request) => calls.push({ backend: 'local', request }),
    isRemoteCwd: (cwd) => cwd.includes('remote-project-anchor'),
    resolveRemote: async (identity) => {
      assert.deepEqual(identity, remoteIdentity)
      return {
        projectCwd: '/server/project',
        execute: async (request) => calls.push({ backend: 'remote', request })
      }
    }
  })

  await router.execute({
    action: 'read',
    cwd: '/local/private/remote-project-anchor',
    params: { path: 'notebooks/a.ipynb' },
    remoteProject: remoteIdentity
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.backend, 'remote')
  assert.equal(calls[0]?.request.cwd, '/server/project')
})

test('notebook host router keeps local requests unchanged', async () => {
  const calls: NotebookToolRequest[] = []
  const router = new NotebookToolHostRouter({
    local: async (request) => calls.push(request),
    isRemoteCwd: () => false,
    resolveRemote: async () => null
  })

  await router.execute(localRequest)
  assert.deepEqual(calls, [localRequest])
})

test('notebook host router fails closed for missing or invalid remote backends', async () => {
  let localCalls = 0
  const router = new NotebookToolHostRouter({
    local: async () => {
      localCalls += 1
    },
    isRemoteCwd: (cwd) => cwd.includes('remote-project-anchor') || cwd === '/canonical/project',
    resolveRemote: async () => null
  })

  await assert.rejects(
    router.execute({ ...localRequest, cwd: '/local/private/remote-project-anchor' }),
    /缺少经过验证的远程 Notebook 后端/
  )
  await assert.rejects(
    router.execute({ ...localRequest, cwd: '/canonical/project' }),
    /缺少经过验证的远程 Notebook 后端/
  )
  await assert.rejects(
    router.execute({ ...localRequest, remoteProject: remoteIdentity }),
    /远程 Notebook 后端不可用/
  )
  await assert.rejects(
    router.execute({
      ...localRequest,
      remoteProject: { ...remoteIdentity, projectId: '' }
    }),
    /身份无效/
  )
  assert.equal(localCalls, 0)
})
