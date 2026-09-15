import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNotebook } from '../src/shared/notebookDocument'
import {
  AnalysisNotebookExecutor,
  buildNotebookVariableIntrospectionCode,
  normalizeJupyterKernelCompletionMessages,
  normalizeJupyterKernelMessages,
  parseNotebookVariableIntrospectionResult,
  type CompleteNotebookCodeInput,
  type JupyterKernelClient,
  type JupyterKernelCompletionResult,
  type JupyterKernelExecuteRequest,
  type JupyterKernelExecuteResult
} from '../src/main/agent/notebook/analysis-jupyter-execution'

class FakeKernelClient implements JupyterKernelClient {
  readonly requests: JupyterKernelExecuteRequest[] = []
  readonly completionRequests: CompleteNotebookCodeInput[] = []
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

  async completeCode(request: CompleteNotebookCodeInput): Promise<JupyterKernelCompletionResult> {
    this.completionRequests.push(request)
    return {
      matches: ['DataFrame', 'date_range'],
      cursorStart: Math.max(0, request.cursorPosition - 2),
      cursorEnd: request.cursorPosition,
      metadata: {},
      status: 'ok'
    }
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

test('normalizeJupyterKernelCompletionMessages reads Jupyter complete_reply payloads', () => {
  const result = normalizeJupyterKernelCompletionMessages(
    [
      {
        header: { msg_type: 'status' },
        content: { execution_state: 'busy' }
      },
      {
        header: { msg_type: 'complete_reply' },
        content: {
          matches: ['DataFrame', 'date_range', 42],
          cursor_start: 3,
          cursor_end: 5,
          metadata: { experimental: true },
          status: 'ok'
        }
      }
    ],
    5
  )

  assert.deepEqual(result.matches, ['DataFrame', 'date_range'])
  assert.equal(result.cursorStart, 3)
  assert.equal(result.cursorEnd, 5)
  assert.deepEqual(result.metadata, { experimental: true })
  assert.equal(result.status, 'ok')
})

test('AnalysisNotebookExecutor requests kernel completion with a clamped cursor', async () => {
  const client = new FakeKernelClient()
  const executor = new AnalysisNotebookExecutor({ client })

  const result = await executor.completeCode({
    connection: { url: 'http://127.0.0.1:8888/lab', token: 'secret' },
    sessionId: 'session-1',
    kernelId: 'kernel-1',
    code: 'pd.da',
    cursorPosition: 500
  })

  assert.equal(client.completionRequests.length, 1)
  assert.equal(client.completionRequests[0].cursorPosition, 5)
  assert.deepEqual(result.matches, ['DataFrame', 'date_range'])
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

test('buildNotebookVariableIntrospectionCode filters invalid variable names', () => {
  const code = buildNotebookVariableIntrospectionCode(['df', '__bad_name', 'bad-name', 'x.y'])

  assert.match(code, /"df"/)
  assert.match(code, /"__bad_name"/)
  assert.doesNotMatch(code, /bad-name/)
  assert.doesNotMatch(code, /x\.y/)
})

test('buildNotebookVariableIntrospectionCode supports R data frame variables', () => {
  const code = buildNotebookVariableIntrospectionCode(['df', 'my.data', 'bad-name', '.2bad'], 'r')

  assert.match(code, /inherits\(value, "data\.frame"\)/)
  assert.match(code, /"df"/)
  assert.match(code, /"my\.data"/)
  assert.doesNotMatch(code, /bad-name/)
  assert.doesNotMatch(code, /\.2bad/)
})

test('parseNotebookVariableIntrospectionResult reads sentinel JSON from stdout', () => {
  const result = parseNotebookVariableIntrospectionResult({
    executionCount: null,
    status: 'ok',
    outputs: [
      {
        outputType: 'stream',
        data: {},
        metadata: {},
        name: 'stdout',
        text: 'noise\n__PHI_NOTEBOOK_VARIABLES__{"variables":[{"name":"df","exists":true,"datatype":"pandas.core.frame.DataFrame","shape":"2 x 3","columns":[{"name":"a","type":"int64"}],"preview":"| a |\\n| 1 |"}]}\n',
        extra: {}
      }
    ]
  })

  assert.deepEqual(result, [
    {
      name: 'df',
      exists: true,
      datatype: 'pandas.core.frame.DataFrame',
      shape: '2 x 3',
      columns: [{ name: 'a', type: 'int64' }],
      preview: '| a |\n| 1 |',
      error: undefined
    }
  ])
})

test('AnalysisNotebookExecutor introspects variables through the kernel without storing history', async () => {
  const client = new FakeKernelClient()
  client.result = {
    executionCount: null,
    status: 'ok',
    outputs: [
      {
        outputType: 'stream',
        data: {},
        metadata: {},
        name: 'stdout',
        text: '__PHI_NOTEBOOK_VARIABLES__{"variables":[{"name":"threshold","exists":true,"datatype":"builtins.float","preview":"0.05"}]}\n',
        extra: {}
      }
    ]
  }
  const executor = new AnalysisNotebookExecutor({ client })

  const result = await executor.introspectVariables({
    connection: { url: 'http://127.0.0.1:8888/lab', token: 'secret' },
    sessionId: 'session-1',
    kernelId: 'kernel-1',
    variableNames: ['threshold']
  })

  assert.equal(client.requests.length, 1)
  assert.equal(client.requests[0].storeHistory, false)
  assert.match(client.requests[0].code, /threshold/)
  assert.deepEqual(result, [
    {
      name: 'threshold',
      exists: true,
      datatype: 'builtins.float',
      preview: '0.05',
      shape: undefined,
      columns: undefined,
      error: undefined
    }
  ])
})

test('AnalysisNotebookExecutor generates R introspection code for R kernels', async () => {
  const client = new FakeKernelClient()
  client.result = {
    executionCount: null,
    status: 'ok',
    outputs: [
      {
        outputType: 'stream',
        data: {},
        metadata: {},
        name: 'stdout',
        text: '__PHI_NOTEBOOK_VARIABLES__{"variables":[{"name":"my.data","exists":true,"datatype":"data.frame","shape":"2 x 1","columns":[{"name":"sample","type":"character"}],"preview":"sample\\nS1"}]}\n',
        extra: {}
      }
    ]
  }
  const executor = new AnalysisNotebookExecutor({ client })

  const result = await executor.introspectVariables({
    connection: { url: 'http://127.0.0.1:8888/lab', token: 'secret' },
    sessionId: 'session-1',
    kernelId: 'kernel-1',
    variableNames: ['my.data'],
    language: 'r'
  })

  assert.equal(client.requests.length, 1)
  assert.equal(client.requests[0].storeHistory, false)
  assert.match(client.requests[0].code, /inherits\(value, "data\.frame"\)/)
  assert.match(client.requests[0].code, /"my\.data"/)
  assert.deepEqual(result, [
    {
      name: 'my.data',
      exists: true,
      datatype: 'data.frame',
      shape: '2 x 1',
      columns: [{ name: 'sample', type: 'character' }],
      preview: 'sample\nS1',
      error: undefined
    }
  ])
})
