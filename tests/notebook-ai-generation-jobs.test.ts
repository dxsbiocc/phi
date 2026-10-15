import assert from 'node:assert/strict'
import test from 'node:test'
import { NotebookAiGenerationJobs } from '../src/main/agent/notebook/notebook-ai-generation-jobs'

const request = {
  requestId: 'draft-1',
  projectCwd: '/projects/research',
  notebookPath: '/projects/research/notebooks/qc.ipynb',
  notebookName: 'qc.ipynb',
  model: 'openai/test',
  prompt: 'Summarize the data'
}

test('Notebook AI jobs expose phase transitions, timestamps and detached snapshots', () => {
  let milliseconds = Date.parse('2026-10-15T02:00:00.000Z')
  const jobs = new NotebookAiGenerationJobs(() => new Date(milliseconds))
  const handle = jobs.begin(request)
  const initial = jobs.list()[0]
  assert.equal(initial.state, 'running')
  assert.equal(initial.phase, 'preparing')
  assert.equal(initial.updatedAt, initial.startedAt)

  milliseconds += 1_000
  handle.update('waiting')
  assert.equal(jobs.list()[0].phase, 'waiting')
  assert.equal(jobs.list()[0].updatedAt, '2026-10-15T02:00:01.000Z')
  handle.update('generating', { sourcePreview: 'result = df.describe()', cellCount: 1 })
  const streaming = jobs.list()[0]
  handle.update('repairing')
  assert.equal(jobs.list()[0].phase, 'repairing')
  assert.equal(streaming.phase, 'generating')
  streaming.sourcePreview = 'modified by observer'
  assert.equal(jobs.list()[0].sourcePreview, 'result = df.describe()')

  milliseconds += 2_000
  handle.complete({ sourcePreview: 'df.describe()', cellCount: 2 })
  const completed = jobs.list()[0]
  assert.equal(completed.state, 'completed')
  assert.equal(completed.phase, 'completed')
  assert.equal(completed.completedAt, '2026-10-15T02:00:03.000Z')
  assert.equal(completed.updatedAt, completed.completedAt)
  assert.equal(completed.cellCount, 2)
  handle.update('generating', { sourcePreview: 'late output' })
  handle.fail(new Error('late failure'))
  assert.deepEqual(jobs.list()[0], completed)
})

test('attempts sharing a draft request have independent IDs and project metadata, newest first', () => {
  const jobs = new NotebookAiGenerationJobs(() => new Date('2026-10-15T02:00:00.000Z'))
  const first = jobs.begin(request)
  const second = jobs.begin({ ...request, projectCwd: 'phi-remote://gpu/project' })
  assert.notEqual(first.id, second.id)
  assert.notEqual(first.id, request.requestId)
  assert.deepEqual(
    jobs.list().map((job) => job.id),
    [second.id, first.id]
  )
  first.fail(new Error('provider unavailable'))
  assert.equal(jobs.list()[0].state, 'running')
  assert.equal(jobs.list()[0].projectCwd, 'phi-remote://gpu/project')
  assert.equal(jobs.list()[1].error, 'provider unavailable')
  assert.ok(jobs.list()[1].completedAt)
  const uncorrelated = jobs.begin({ ...request, requestId: undefined })
  assert.equal(jobs.list()[0].requestId, uncorrelated.id)
})

test('only the newest 50 finished attempts are kept, without evicting active jobs', () => {
  const jobs = new NotebookAiGenerationJobs()
  const active = Array.from({ length: 60 }, () => jobs.begin(request))
  for (let index = 0; index < 75; index += 1) {
    const job = jobs.begin({ ...request, prompt: `Attempt ${index}` })
    if (index % 2) job.fail('provider error')
    else job.complete({ sourcePreview: 'df.head()', cellCount: 1 })
  }
  const snapshot = jobs.list()
  assert.equal(snapshot.length, 110)
  assert.equal(snapshot.filter((job) => job.state !== 'running').length, 50)
  assert.deepEqual(
    snapshot.slice(50).map((job) => job.id),
    active.map((job) => job.id).reverse()
  )
  assert.equal(snapshot[0].prompt, 'Attempt 74')
  assert.equal(snapshot[49].prompt, 'Attempt 25')
})

test('job prompts, generated previews and errors remain bounded', () => {
  const jobs = new NotebookAiGenerationJobs()
  const handle = jobs.begin({ ...request, prompt: 'p'.repeat(100_000) })
  handle.update('generating', { sourcePreview: 's'.repeat(100_000), cellCount: 1 })
  assert.equal(jobs.list()[0].prompt.length, 4_000)
  assert.equal(jobs.list()[0].sourcePreview?.length, 20_000)
  handle.fail(new Error('e'.repeat(100_000)))
  assert.equal(jobs.list()[0].error?.length, 4_000)
  assert.equal(jobs.list()[0].phase, 'failed')
  assert.ok(jobs.list()[0].completedAt)
  const completed = jobs.begin(request)
  completed.complete({ sourcePreview: 'c'.repeat(100_000), cellCount: 3 })
  assert.equal(jobs.list()[0].sourcePreview?.length, 20_000)
})

test('structured previews retain cell types, cap source length, and detach observers', () => {
  const jobs = new NotebookAiGenerationJobs()
  const handle = jobs.begin(request)
  const cells = [
    { cellType: 'markdown' as const, source: '## Findings\nA short explanation.' },
    { cellType: 'code' as const, language: 'python', source: 'x'.repeat(30_000) }
  ]
  handle.update('generating', {
    sourcePreview: cells.map((cell) => cell.source).join('\n\n'),
    previewCells: cells
  })

  const snapshot = jobs.list()[0]
  assert.equal(snapshot.previewCells?.[0].cellType, 'markdown')
  assert.equal(snapshot.previewCells?.[1].language, 'python')
  assert.ok(
    (snapshot.previewCells?.reduce((length, cell) => length + cell.source.length, 0) ?? 0) <= 20_000
  )
  cells[0].source = 'changed at source'
  if (snapshot.previewCells?.[0]) snapshot.previewCells[0].source = 'changed by observer'
  assert.equal(jobs.list()[0].previewCells?.[0].source, '## Findings\nA short explanation.')
})

test('live Notebook attempts retain real reasoning, text and action events across repair and failure', () => {
  const jobs = new NotebookAiGenerationJobs(() => new Date('2026-10-15T02:00:00.000Z'))
  const handle = jobs.begin(request)
  handle.update('waiting')
  const observe = (type: string, fields: Record<string, unknown> = {}): void =>
    handle.observe({ type, ...fields })
  const stream = (type: string, fields: Record<string, unknown> = {}): void =>
    observe('message_update', {
      assistantMessageEvent: { type, contentIndex: 0, ...fields }
    })

  stream('thinking_start')
  stream('thinking_delta', { delta: 'Check the ' })
  stream('thinking_delta', { delta: 'failed import.' })
  stream('thinking_end', { content: 'Check the failed import.' })
  stream('text_delta', { delta: 'The package is missing.' })
  observe('tool_execution_start', {
    toolCallId: 'inspect-1',
    toolName: 'read',
    intent: 'Inspect the traceback'
  })
  observe('tool_execution_update', {
    toolCallId: 'inspect-1',
    partialResult: { content: [{ type: 'text', text: 'ModuleNotFoundError' }] }
  })
  observe('tool_execution_end', {
    toolCallId: 'inspect-1',
    result: { content: [{ type: 'text', text: 'scanpy is unavailable' }] }
  })
  const streaming = jobs.list()[0]
  assert.equal(streaming.phase, 'generating')
  assert.equal(
    streaming.entries?.find((entry) => entry.kind === 'thinking')?.text,
    'Check the failed import.'
  )
  assert.equal(
    streaming.entries?.find((entry) => entry.kind === 'text')?.text,
    'The package is missing.'
  )
  assert.equal(streaming.entries?.find((entry) => entry.kind === 'action')?.label, 'read')
  assert.equal(streaming.entries?.find((entry) => entry.kind === 'action')?.status, 'completed')
  assert.match(
    streaming.entries?.find((entry) => entry.kind === 'action')?.text ?? '',
    /scanpy is unavailable/
  )

  handle.update('repairing')
  observe('message_start', { message: { role: 'assistant' } })
  stream('text_delta', { delta: 'Repair response' })
  assert.equal(jobs.list()[0].phase, 'repairing')
  handle.fail(new Error('provider disconnected'))
  const failed = jobs.list()[0]
  assert.ok(failed.entries?.some((entry) => entry.text === 'Check the failed import.'))
  assert.ok(failed.entries?.some((entry) => entry.text === 'Repair response'))
  assert.ok(
    failed.entries?.some((entry) => entry.kind === 'phase' && entry.text === '修正生成结果')
  )
  assert.equal(failed.entries?.at(-1)?.text, '生成失败')
  streaming.entries![0].text = 'observer mutation'
  assert.notEqual(jobs.list()[0].entries?.[0].text, 'observer mutation')
  handle.observe({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'late' }
  })
  assert.deepEqual(jobs.list()[0], failed)
})

test('Notebook activity coalesces token deltas, deduplicates final snapshots and caps retained content', () => {
  const jobs = new NotebookAiGenerationJobs()
  const handle = jobs.begin(request)
  for (let index = 0; index < 5_000; index += 1) {
    handle.observe({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'a' }
    })
  }
  handle.observe({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'a'.repeat(5_000) }
  })
  assert.equal(jobs.list()[0].entries?.filter((entry) => entry.kind === 'text').length, 1)
  assert.equal(jobs.list()[0].entries?.find((entry) => entry.kind === 'text')?.text.length, 5_000)
  for (let index = 0; index < 200; index += 1) {
    handle.observe({ type: 'message_start', message: { role: 'assistant' } })
    handle.observe({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x'.repeat(30_000) },
          { type: 'text', text: 'y'.repeat(30_000) }
        ]
      }
    })
  }
  const entries = jobs.list()[0].entries ?? []
  assert.ok(entries.length > 0 && entries.length <= 80)
  assert.ok(entries.every((entry) => entry.text.length <= 8_000))
  assert.ok(entries.reduce((length, entry) => length + entry.text.length, 0) <= 40_000)
  assert.equal(entries.at(-1)?.kind, 'text')
  assert.equal(entries.at(-1)?.text, 'y'.repeat(8_000))
})

test('text-only providers do not gain invented thoughts or actions, and repair gets a fresh stream', () => {
  const jobs = new NotebookAiGenerationJobs()
  const handle = jobs.begin(request)
  handle.update('waiting')
  handle.observe({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Initial response' }
  })
  handle.update('repairing')
  handle.observe({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Repaired response' }
  })
  handle.complete({ sourcePreview: 'df.shape', cellCount: 1 })
  const entries = jobs.list()[0].entries ?? []
  assert.deepEqual(
    entries.filter((entry) => entry.kind === 'text').map((entry) => entry.text),
    ['Initial response', 'Repaired response']
  )
  assert.ok(entries.every((entry) => entry.kind !== 'thinking' && entry.kind !== 'action'))
  assert.ok(
    entries.filter((entry) => entry.kind === 'text').every((entry) => entry.status === 'completed')
  )
})
