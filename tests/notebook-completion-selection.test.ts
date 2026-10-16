import assert from 'node:assert/strict'
import test from 'node:test'
import { NotebookCompletionCollector } from '../src/main/agent/notebook/notebook-completion'
import {
  parseFinalGeneratedNotebookCompletion,
  parseGeneratedNotebookCompletionSnapshot
} from '../src/shared/notebookCodeGeneration'
import type { PhiAgentEventSummary } from '../src/main/agent/engine/types'

const markdownSource = '## 过滤参数\n\n阈值由 **矩阵含义** 决定。'
const markdownCells = [{ cellType: 'markdown' as const, source: markdownSource }]
const answer = JSON.stringify({ cells: [{ language: 'markdown', code: markdownSource }] })
const message = (text: string): Record<string, unknown> => ({
  role: 'assistant',
  content: [{ type: 'text', text }]
})

function update(type: string, fields: Record<string, unknown>): PhiAgentEventSummary {
  return { type: 'message_update', assistantMessageEvent: { type, ...fields } }
}

test('Notebook completion never publishes reasoning, tool calls, errors or diagnostics', () => {
  const collector = new NotebookCompletionCollector()
  const diagnostic = JSON.stringify({
    cells: [{ language: 'python', code: 'raise RuntimeError()' }]
  })
  for (const type of [
    'thinking_delta',
    'thinking_end',
    'reasoning_delta',
    'toolcall_delta',
    'error',
    'log'
  ]) {
    collector.observe(
      update(type, {
        delta: diagnostic,
        content: diagnostic,
        data: { type: 'data-notebook-cells-completion', data: { cells: [{ code: diagnostic }] } },
        partial: message(diagnostic)
      })
    )
    assert.equal(collector.text, '')
    assert.equal(collector.select('python', parseGeneratedNotebookCompletionSnapshot), null)
  }
  collector.observe(update('text_delta', { delta: answer }))
  assert.deepEqual(
    collector.select('markdown', parseFinalGeneratedNotebookCompletion)?.cells,
    markdownCells
  )
})

test('Notebook completion aggregates token deltas before parsing, never ranks individual chunks', () => {
  const collector = new NotebookCompletionCollector()
  const parsedCandidates: unknown[] = []
  for (const delta of [...answer]) collector.observe(update('text_delta', { delta }))
  const completion = collector.select('markdown', (candidate, language) => {
    parsedCandidates.push(candidate)
    return parseFinalGeneratedNotebookCompletion(candidate, language)
  })
  assert.deepEqual(parsedCandidates, [answer])
  assert.deepEqual(completion?.cells, markdownCells)
})

test('Notebook final assistant answer supersedes a much longer valid code partial', () => {
  const collector = new NotebookCompletionCollector()
  const partial = JSON.stringify({
    cells: [{ language: 'python', code: 'print(1)\n'.repeat(500) }]
  })
  collector.observe(update('partial', { partial: message(partial) }))
  collector.observe(update('done', { message: message(answer) }))
  assert.deepEqual(
    collector.select('markdown', parseFinalGeneratedNotebookCompletion)?.cells,
    markdownCells
  )
  assert.equal(collector.text, answer)
})

test('Notebook invalid final response needs repair instead of resurrecting a valid stale draft', () => {
  const collector = new NotebookCompletionCollector()
  collector.observe(update('partial', { partial: message(answer) }))
  collector.observe(update('done', { message: message('I cannot produce the requested cells.') }))
  assert.equal(collector.select('markdown', parseFinalGeneratedNotebookCompletion), null)
  assert.equal(collector.text, 'I cannot produce the requested cells.')
})

for (const finalEvent of ['done', 'message_end', 'agent_end', 'result'] as const) {
  test(`Notebook completion accepts the final ${finalEvent} assistant message without reasoning content`, () => {
    const collector = new NotebookCompletionCollector()
    const final = message(answer)
    ;(final.content as unknown[]).unshift({ type: 'thinking', content: '```python\nprint(1)\n```' })
    collector.observe(
      finalEvent === 'done'
        ? update('done', { message: final })
        : finalEvent === 'message_end'
          ? { type: 'message_end', message: final }
          : finalEvent === 'agent_end'
            ? { type: 'agent_end', messages: [{ role: 'toolResult', content: answer }, final] }
            : { type: 'result', result: { messages: [final] } }
    )
    assert.deepEqual(
      collector.select('markdown', parseFinalGeneratedNotebookCompletion)?.cells,
      markdownCells
    )
    assert.equal(collector.text, answer)
  })
}

test('Notebook completion supports provider object deltas and message text snapshots', () => {
  const collector = new NotebookCompletionCollector()
  collector.observe(
    update('message_delta', {
      delta: { content: [{ type: 'output_text', text: answer.slice(0, 25) }] }
    })
  )
  collector.observe(
    update('text_delta', {
      delta: { content: [{ type: 'output_text', text: answer.slice(25) }] }
    })
  )
  assert.equal(collector.text, answer)
  assert.deepEqual(
    collector.select('markdown', parseFinalGeneratedNotebookCompletion)?.cells,
    markdownCells
  )
})

test('Notebook completion retains supported provider answer envelopes without harvesting logs', () => {
  for (const container of ['data', 'value', 'result', 'output', 'outputs', 'message']) {
    const collector = new NotebookCompletionCollector()
    collector.observe(
      update('text_delta', {
        delta: { [container]: { content: [{ type: 'output_text', text: answer }] } }
      })
    )
    assert.deepEqual(
      collector.select('markdown', parseFinalGeneratedNotebookCompletion)?.cells,
      markdownCells
    )
  }
})

for (const type of ['data-notebook-cells-completion', 'data-cell-completion']) {
  test(`Notebook completion accepts explicit ${type} protocol events and nested deltas`, () => {
    const data =
      type === 'data-cell-completion'
        ? { language: 'markdown', code: markdownSource }
        : { cells: [{ language: 'markdown', code: markdownSource }] }
    for (const event of [
      update(type, { data }),
      update('message_delta', { delta: { type, data } }),
      { type, data }
    ]) {
      const collector = new NotebookCompletionCollector()
      collector.observe(event)
      assert.deepEqual(
        collector.select('markdown', parseFinalGeneratedNotebookCompletion)?.cells,
        markdownCells
      )
    }
  })
}

test('Notebook completion falls back to session history while done event output stays authoritative', () => {
  const collector = new NotebookCompletionCollector()
  assert.deepEqual(
    collector.select('markdown', parseFinalGeneratedNotebookCompletion, [message(answer)])?.cells,
    markdownCells
  )
  collector.observe(update('done', { message: message(answer) }))
  assert.deepEqual(
    collector.select('markdown', parseFinalGeneratedNotebookCompletion, [message('done')])?.cells,
    markdownCells
  )
})

test('Notebook completion starts a new assistant answer without retaining prior drafts', () => {
  const collector = new NotebookCompletionCollector()
  collector.observe(
    update('done', { message: message(JSON.stringify({ cells: [{ code: 'print(1)' }] })) })
  )
  collector.observe({ type: 'message_start', message: { role: 'assistant', content: [] } })
  collector.observe(update('text_delta', { delta: answer }))
  assert.deepEqual(
    collector.select('markdown', parseFinalGeneratedNotebookCompletion)?.cells,
    markdownCells
  )
})
