import assert from 'node:assert/strict'
import test from 'node:test'

import { buildEnvRequestTool } from '../src/main/agent/content/env-request-tool'
import type { SkillHostRequest } from '../src/main/agent/content/skill-tools'

test('remote env_request forwards verified identity and cancels by request id', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let finish: ((value: unknown) => void) | undefined
  const request: SkillHostRequest = async (method, params) => {
    const body = params as Record<string, unknown>
    calls.push({ method, params: body })
    if (method === 'environments.request') {
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    if (method === 'environments.cancel') {
      finish?.({ error: '远程环境创建已取消' })
      return undefined
    }
    throw new Error(`unexpected ${method}`)
  }
  const tool = buildEnvRequestTool(request, {
    runtimeSessionId: 'runtime-1',
    requireEnvironment: true,
    remoteProject: { sessionId: 'phi-session-1', projectId: 'project-1' }
  })
  const controller = new AbortController()
  const pending = tool.execute(
    'call-1',
    { packages: ['six'], reason: 'need six', environment: 'phi:python@1' },
    undefined,
    { sessionManager: { getCwd: () => '/local/anchor' } } as never,
    controller.signal
  )
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  const result = await pending
  assert.equal(calls[0]?.method, 'environments.request')
  assert.equal(calls[0]?.params.remoteSessionId, 'phi-session-1')
  assert.equal(calls[0]?.params.projectId, 'project-1')
  assert.equal(typeof calls[0]?.params.requestId, 'string')
  assert.deepEqual(calls[1], {
    method: 'environments.cancel',
    params: {
      requestId: calls[0]?.params.requestId,
      runtimeSessionId: 'runtime-1',
      remoteSessionId: 'phi-session-1',
      projectId: 'project-1'
    }
  })
  assert.equal(result.isError, true)
  assert.match((result.content[0] as { text: string }).text, /取消/u)
})
