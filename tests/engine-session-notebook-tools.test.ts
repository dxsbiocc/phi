import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSessionNotebookTools } from '../src/main/agent/engine/in-process/session-notebook-tools'

type Call = { method: string; params: unknown; context: unknown }

async function runList(
  remote: { sessionId: string; projectId: string } | undefined
): Promise<Call[]> {
  const calls: Call[] = []
  const tools = buildSessionNotebookTools(
    async (method, params, context) => {
      calls.push({ method, params, context })
      return { summary: 'ok' }
    },
    'runtime-1',
    remote
  )
  const list = tools.find((tool) => tool.name === 'notebook_list')!
  await list.execute('call-1', {}, undefined, { cwd: '/project' } as never)
  return calls
}

test('in-process remote notebook requests carry the runtime session as their origin', async () => {
  const [call] = await runList({ sessionId: 'phi-session', projectId: 'project-1' })
  assert.equal(call!.method, 'notebookTool.execute')
  assert.deepEqual(call!.context, { originSessionId: 'runtime-1' })
  assert.deepEqual((call!.params as { remoteProject: unknown }).remoteProject, {
    runtimeSessionId: 'runtime-1',
    sessionId: 'phi-session',
    projectId: 'project-1'
  })
})

test('in-process local notebook requests carry no remote identity', async () => {
  const [call] = await runList(undefined)
  assert.equal((call!.params as { remoteProject?: unknown }).remoteProject, undefined)
})
