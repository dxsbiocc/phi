import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auditDesktopText,
  observeDesktopCases,
  observeDesktopLeaks,
  desktopObserverReason,
  stopAfterObservation
} from './desktop-ui.mjs'

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

test('a closing Electron page cannot replace already recorded case diagnostics', async () => {
  const closed = new Error(
    'locator.isVisible: Target page, context or browser has been closed. Sensitive text'
  )
  for (const action of ['probe', 'click']) {
    const stop = {
      isVisible: async () => {
        if (action === 'probe') throw closed
        return true
      },
      click: async () => {
        throw closed
      }
    }
    const chat = { locator: () => ({ last: () => stop }) }
    await assert.doesNotReject(stopAfterObservation(chat))
  }
})

test('safe observer reasons separate a closed page from timeout and selector failure', () => {
  assert.equal(
    desktopObserverReason(
      new Error('locator.click: Target page, context or browser has been closed. leaked-body')
    ),
    'desktop-target-closed'
  )
  assert.equal(
    desktopObserverReason(new Error('locator.click: Timeout 30000ms exceeded. leaked-body')),
    'desktop-action-timeout'
  )
  assert.equal(
    desktopObserverReason(new Error('locator.click: strict mode violation. leaked-body')),
    'desktop-selector-failed'
  )
  assert.equal(
    desktopObserverReason(new Error('unclassified exception with leaked-body')),
    'desktop-interaction-failed'
  )
  assert.equal(
    desktopObserverReason(new Error('timeout 3000ms exceeded'), true),
    'desktop-target-closed'
  )
})

test('closed window during startup attributes an interruption independently to each case', async () => {
  const results = []
  await assert.rejects(
    observeDesktopCases(
      ['paired', 'zero'],
      async () => {
        throw new Error('Target closed - sensitive context')
      },
      (_, result) => results.push(result)
    ),
    /failed for paired, zero/
  )
  assert.deepEqual(
    results.map((r) => [r.kind, r.status, r.observation, r.interruptionReason]),
    [
      ['paired', 'failed', 'interrupted', 'desktop-target-closed'],
      ['zero', 'failed', 'interrupted', 'desktop-target-closed']
    ]
  )
  assert(!JSON.stringify(results).includes('sensitive'))
})
