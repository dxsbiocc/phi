import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNotebook } from '../src/shared/notebookDocument'
import {
  AnalysisNotebookExecutor,
  normalizeJupyterKernelMessages,
  type JupyterKernelClient,
  type JupyterKernelExecuteRequest,
  type JupyterKernelExecuteResult
} from '../src/main/agent/notebook/analysis-jupyter-execution'

class FakeKernelClient implements JupyterKernelClient {
  readonly requests: JupyterKernelExecuteRequest[] = []
  result: JupyterKernelExecuteResult = {
    executionCount: 7,
    outputs: [
      {
        outputType: 'stream',
        data: {},
        metadata: {},
        name: 'stdout',
        text: 'done\n',
        extra: {}
      }
    ],
    status: 'ok'
  }

  async executeCode(request: JupyterKernelExecuteRequest): Promise<JupyterKernelExecuteResult> {
    this.requests.push(request)
    return this.result
  }
}

test('normalizeJupyterKernelMessages converts common Jupyter outputs to notebook outputs', () => {
  const result = normalizeJupyterKernelMessages([
    {
      header: { msg_type: 'execute_input' },
      content: { execution_count: 3 }
    },
    {
      header: { msg_type: 'stream' },
      content: { name: 'stdout', text: ['hello\n'] }
    },
    {
      header: { msg_type: 'execute_result' },
      content: {
        execution_count: 3,
        data: { 'text/plain': '42' },
        metadata: {}
      }
    },
    {
      header: { msg_type: 'display_data' },
      content: {
        data: { 'image/png': 'base64' },
        metadata: { width: 240 }
      }
    }
  ])

  assert.equal(result.status, 'ok')
  assert.equal(result.executionCount, 3)
  assert.deepEqual(
    result.outputs.map((output) => output.outputType),
    ['stream', 'execute_result', 'display_data']
  )
  assert.equal(result.outputs[0].text, 'hello\n')
  assert.equal(result.outputs[1].data['text/plain'], '42')
  assert.equal(result.outputs[2].metadata.width, 240)
})

test('normalizeJupyterKernelMessages preserves kernel errors as notebook error outputs', () => {
  const result = normalizeJupyterKernelMessages([
    {
      header: { msg_type: 'execute_input' },
      content: { execution_count: 4 }
    },
    {
      header: { msg_type: 'error' },
      content: {
        ename: 'ValueError',
        evalue: 'bad value',
        traceback: ['ValueError: bad value']
      }
    },
    {
      header: { msg_type: 'execute_reply' },
      content: { status: 'error', execution_count: 4 }
    }
  ])

  assert.equal(result.status, 'error')
  assert.equal(result.executionCount, 4)
  assert.equal(result.outputs[0].outputType, 'error')
  assert.equal(result.outputs[0].ename, 'ValueError')
  assert.deepEqual(result.outputs[0].traceback, ['ValueError: bad value'])
})

test('AnalysisNotebookExecutor executes code cells through the kernel client', async () => {
  const client = new FakeKernelClient()
  const executor = new AnalysisNotebookExecutor({
    client,
    now: () => new Date('2026-09-09T00:00:00.000Z')
  })
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{ id: 'cell-1', cell_type: 'code', metadata: {}, source: 'print("done")' }]
  })

  const result = await executor.executeCell({
    connection: { url: 'http://127.0.0.1:8888/lab', token: 'secret' },
    sessionId: 'session-1',
    kernelId: 'kernel-1',
    cell: document.cells[0]
  })

  assert.equal(client.requests.length, 1)
  assert.equal(client.requests[0].code, 'print("done")')
  assert.equal(client.requests[0].kernelId, 'kernel-1')
  assert.equal(result.cellId, 'cell-1')
  assert.equal(result.executionCount, 7)
  assert.equal(result.outputs[0].text, 'done\n')
  assert.equal(result.state, 'idle')
})

test('AnalysisNotebookExecutor rejects non-code cells', async () => {
  const executor = new AnalysisNotebookExecutor({ client: new FakeKernelClient() })
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{ id: 'note', cell_type: 'markdown', metadata: {}, source: '# Note' }]
  })

  await assert.rejects(
    executor.executeCell({
      connection: { url: 'http://127.0.0.1:8888/lab' },
      sessionId: 'session-1',
      kernelId: 'kernel-1',
      cell: document.cells[0]
    }),
    /只能执行 code cell/
  )
})
