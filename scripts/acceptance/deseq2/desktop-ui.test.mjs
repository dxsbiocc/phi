import assert from 'node:assert/strict'
import test from 'node:test'
import { auditDesktopText, observeDesktopCases, observeDesktopLeaks } from './desktop-ui.mjs'

test('a gene citation or local artifact link is compact scientific evidence', () => {
  for (const text of [
    'SYN0001 is an example of a differentially expressed gene.',
    'SYN0001 and SYN0002 belong to the same set.',
    '[差异分析结果](paired/results/screen.deseq2.results.tsv)',
    '[本地运行记录](results/nextflow.log)'
  ])
    assert.doesNotThrow(() => auditDesktopText(text, 'reply'))
})

test('raw matrix rows, table headers, structured rows and workflow output are detected', () => {
  for (const text of [
    'SYN0001\t154.3\t2.1\t0.05',
    '| SYN0002 | -1.1 | 0.003 |',
    '{"gene_id":"SYN0010","baseMean":99}',
    JSON.stringify({ finalReport: JSON.stringify({ answer: 'SYN0010\t19.2\t2.6' }) }),
    'gene_id\tbaseMean\tlog2FoldChange\tlfcSE\tpvalue\tpadj',
    'sample-aabbccdd\ttreated',
    'sample-0123456789ab\ttreated',
    'sample\tcondition',
    'gene_set\tdescription\tset_size\toverlap',
    'Submitted process > DESEQ2_DIFFERENTIAL (screen)'
  ])
    assert.throws(() => auditDesktopText(text, 'reply'), /Raw intermediate data/)
})

test('leaks remain failed evidence without preventing observation of later interaction', async () => {
  const leaks = new Map()
  const time = '2026-11-19T12:25:00.000Z'
  const raw = 'gene_id\tbaseMean\tlog2FoldChange\tlfcSE'
  const events = [
    { eventId: '1', type: 'user_message', content: raw, createdAt: time },
    { eventId: '2', type: 'tool_call_completed', toolName: 'read', output: raw, createdAt: time }
  ]
  observeDesktopLeaks(leaks, events, 'Awaiting reply', time)
  events.push({ eventId: '3', type: 'input_answered', createdAt: time })
  observeDesktopLeaks(leaks, events, raw, time)
  observeDesktopLeaks(leaks, events, 'The analysis is complete', time)
  assert.deepEqual(
    [...leaks.values()],
    [
      { location: 'saved-session', eventType: 'tool_call_completed', time, tool: 'read' },
      { location: 'rendered-chat', eventType: 'visible-text', time }
    ]
  )
  assert(!JSON.stringify([...leaks.values()]).includes('gene_id'))
})

test('a failed case cannot skip the other scenario or turn the suite green', async () => {
  const outcomes = []
  await assert.rejects(
    observeDesktopCases(
      ['paired', 'zero'],
      async (kind) => {
        if (kind === 'paired')
          return { kind, status: 'failed', failedGates: ['raw-content-in-main-chat'] }
        return { kind, status: 'passed' }
      },
      (name, result) => outcomes.push([name, result.status])
    ),
    /failed for paired/
  )
  assert.deepEqual(outcomes, [
    ['paired', 'failed'],
    ['zero', 'passed']
  ])
})
