import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildNotebookCustomTools,
  NOTEBOOK_TOOL_DESCRIPTIONS,
  NOTEBOOK_TOOL_NAMES,
  type NotebookToolRequest
} from '../src/main/agent/notebook/notebook-tools'

function fakeCtx(cwd: string): { sessionManager: { getCwd: () => string } } {
  return { sessionManager: { getCwd: () => cwd } }
}

test('buildNotebookCustomTools exposes live notebook operations', () => {
  const tools = buildNotebookCustomTools(async () => ({}))

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...NOTEBOOK_TOOL_NAMES]
  )
  assert.deepEqual(
    tools.map((tool) => tool.description),
    NOTEBOOK_TOOL_NAMES.map((name) => NOTEBOOK_TOOL_DESCRIPTIONS.get(name))
  )
  assert.deepEqual(
    tools.map((tool) => tool.approval),
    ['read', 'read', 'write', 'write', 'write', 'write', 'write']
  )
})

test('notebook insert tool exposes one-based cellNumber instead of zero-based index', () => {
  const tools = buildNotebookCustomTools(async () => ({}))
  const tool = tools.find((candidate) => candidate.name === 'notebook.insert_cell')
  assert.ok(tool)

  const parameters = tool.parameters as {
    properties?: Record<string, unknown>
  }

  assert.ok(parameters.properties?.cellNumber)
  assert.equal(parameters.properties?.index, undefined)
})

test('notebook tools forward the session cwd, action, and params to the host executor', async () => {
  const calls: NotebookToolRequest[] = []
  const tools = buildNotebookCustomTools(async (request) => {
    calls.push(request)
    return { summary: 'ok', kind: 'test_result', value: 42 }
  })
  const tool = tools.find((candidate) => candidate.name === 'notebook.update_cell')
  assert.ok(tool)

  const result = await tool.execute(
    'call-1',
    { path: 'analysis.ipynb', cellId: 'cell-1', source: 'x = 2' },
    undefined,
    fakeCtx('/tmp/project') as never
  )

  assert.equal(result.isError, undefined)
  assert.equal(result.content[0]?.type, 'text')
  assert.equal(result.content[0]?.text, 'ok')
  assert.deepEqual(calls, [
    {
      action: 'update_cell',
      cwd: '/tmp/project',
      params: { path: 'analysis.ipynb', cellId: 'cell-1', source: 'x = 2' }
    }
  ])
  assert.deepEqual(result.details, { summary: 'ok', kind: 'test_result', value: 42 })
})

test('notebook tools return tool errors instead of throwing host failures', async () => {
  const [tool] = buildNotebookCustomTools(async () => {
    throw new Error('host failed')
  })

  const result = await tool.execute('call-1', {}, undefined, fakeCtx('/tmp/project') as never)

  assert.equal(result.isError, true)
  assert.equal(result.content[0]?.text, 'host failed')
})

test('remote notebook tools attach trusted routing identity outside model params', async () => {
  const calls: NotebookToolRequest[] = []
  const tools = buildNotebookCustomTools(
    async (request) => {
      calls.push(request)
      return { summary: 'ok' }
    },
    {
      remoteProject: {
        runtimeSessionId: 'runtime-1',
        sessionId: 'phi-session-1',
        projectId: 'project-1'
      }
    }
  )
  const tool = tools.find((candidate) => candidate.name === 'notebook.read')
  assert.ok(tool)

  await tool.execute(
    'call-1',
    { path: 'analysis.ipynb', remoteProject: { projectId: 'forged' } },
    undefined,
    fakeCtx('/local/private/remote-project-anchor') as never
  )

  assert.deepEqual(calls, [
    {
      action: 'read',
      cwd: '/local/private/remote-project-anchor',
      params: { path: 'analysis.ipynb', remoteProject: { projectId: 'forged' } },
      remoteProject: {
        runtimeSessionId: 'runtime-1',
        sessionId: 'phi-session-1',
        projectId: 'project-1'
      }
    }
  ])
})
