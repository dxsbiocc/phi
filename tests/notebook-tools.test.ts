import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildNotebookCustomTools,
  type NotebookToolRequest
} from '../src/main/agent/notebook/notebook-tools'

function fakeCtx(cwd: string): { sessionManager: { getCwd: () => string } } {
  return { sessionManager: { getCwd: () => cwd } }
}

test('buildNotebookCustomTools exposes live notebook operations', () => {
  const tools = buildNotebookCustomTools(async () => ({}))

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'notebook.list',
      'notebook.read',
      'notebook.insert_cell',
      'notebook.update_cell',
      'notebook.delete_cell',
      'notebook.run_cell',
      'notebook.save'
    ]
  )
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
