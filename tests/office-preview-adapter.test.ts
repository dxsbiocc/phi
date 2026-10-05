import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { adaptOfficePreviewHtml } from '../src/main/agent/office/office-preview-adapter'
import { createOfficePreviewAdapterHarness } from './helpers/officePreviewAdapterHarness'

function injectedScript(readOnly: boolean): string {
  const html = adaptOfficePreviewHtml(
    '<html><head><script id="upstream">window.upstream=true</script></head><body></body></html>',
    readOnly
  )
  const adapter = html.match(/<script data-phi-office-adapter>([\s\S]*?)<\/script>/u)?.[1]
  assert.ok(adapter)
  assert.ok(html.indexOf('data-phi-office-adapter') < html.indexOf('id="upstream"'))
  return adapter
}

test('preview adapter reloads after a failed cell edit response but not after success', async () => {
  for (const ok of [false, true]) {
    let reloads = 0
    const context = {
      window: {
        fetch: (async () => ({ ok })) as (
          input?: unknown,
          init?: unknown
        ) => Promise<{ ok: boolean }>,
        location: { href: 'http://127.0.0.1:42001/', reload: () => (reloads += 1) },
        addEventListener: () => undefined
      },
      URL,
      queueMicrotask
    }
    vm.runInNewContext(injectedScript(false), context)
    await context.window.fetch('/api/send', { method: 'POST' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(reloads, ok ? 0 : 1)
  }
})

test('read-only preview adapter captures and cancels double click editing', () => {
  let listener:
    ((event: { preventDefault(): void; stopImmediatePropagation(): void }) => void) | undefined
  const context = {
    window: {
      fetch: async () => ({ ok: true }),
      location: { href: 'http://127.0.0.1:42001/', reload: () => undefined },
      addEventListener: (name: string, callback: typeof listener, capture: boolean) => {
        if (name !== 'dblclick') return
        assert.equal(capture, true)
        listener = callback
      }
    },
    URL,
    queueMicrotask
  }
  vm.runInNewContext(injectedScript(true), context)
  let prevented = 0
  listener?.({
    preventDefault: () => {
      prevented += 1
    },
    stopImmediatePropagation: () => {
      prevented += 1
    }
  })
  assert.equal(prevented, 2)
})

test('preview adapter makes Escape restore the edit input so the upstream blur-commit sends nothing', () => {
  const listeners = new Map<string, (event: unknown) => void>()
  const context = {
    window: {
      fetch: async () => ({ ok: true }),
      location: { href: 'http://127.0.0.1:42001/', reload: () => undefined },
      addEventListener: (name: string, callback: (event: unknown) => void, capture: boolean) => {
        if (name === 'focusin' || name === 'keydown') {
          assert.equal(capture, true, `${name} must run before the page's own handlers`)
          listeners.set(name, callback)
        }
      }
    },
    URL,
    queueMicrotask
  }
  vm.runInNewContext(injectedScript(false), context)
  const focusin = listeners.get('focusin')
  const keydown = listeners.get('keydown')
  assert.ok(focusin && keydown)

  // The upstream page creates the input with the cell's current text, then focuses it.
  const input = { tagName: 'INPUT', value: '=SUM(A1:A2)' }
  focusin({ target: input })
  input.value = 'typed but then cancelled'
  keydown({ key: 'Enter', target: input })
  assert.equal(input.value, 'typed but then cancelled', 'Enter must keep the typed text to commit')
  keydown({ key: 'Escape', target: input })
  assert.equal(input.value, '=SUM(A1:A2)', 'Escape must restore the original text')

  const other = { tagName: 'DIV', value: 'x' }
  other.value = 'y'
  keydown({ key: 'Escape', target: other })
  assert.equal(other.value, 'y', 'only text inputs are touched')
})

test('preview adapter highlights exactly A1:B3 on the addressed worksheet', () => {
  const harness = createOfficePreviewAdapterHarness()

  harness.emitHighlight('Sheet1', 'A1:B3', false)

  assert.deepEqual(harness.highlightedPaths(), [
    '/Sheet1/A1',
    '/Sheet1/A2',
    '/Sheet1/A3',
    '/Sheet1/B1',
    '/Sheet1/B2',
    '/Sheet1/B3'
  ])
})

test('AI highlight styling uses a visible outline and text label', () => {
  const script = injectedScript(false)
  assert.match(script, /outline:3px solid/u)
  assert.match(script, /content:"AI"/u)
  assert.match(script, /\.textContent=/u)
  assert.doesNotMatch(script, /innerHTML/u)
})

test('preview adapter never highlights equal cell coordinates on another worksheet', () => {
  const harness = createOfficePreviewAdapterHarness()

  harness.emitHighlight('Sheet1', 'A1:B2', false)

  assert.equal(harness.highlightedPaths().includes('/Sheet2/A1'), false)
  assert.equal(harness.highlightedPaths().includes('/Sheet2/B2'), false)
})

test('preview adapter degrades a range above 2000 cells to its visible boundary', () => {
  const harness = createOfficePreviewAdapterHarness()

  harness.emitHighlight('Sheet1', 'A1:J201', false)

  assert.deepEqual(harness.highlightedPaths(), [
    '/Sheet1/A1',
    '/Sheet1/A2',
    '/Sheet1/A3',
    '/Sheet1/B1',
    '/Sheet1/C1'
  ])
})

test('preview adapter keeps only the latest highlight and clears it after nine seconds', () => {
  const harness = createOfficePreviewAdapterHarness()
  harness.emitHighlight('Sheet1', 'A1', false)
  assert.deepEqual(harness.highlightedPaths(), ['/Sheet1/A1'])

  harness.emitHighlight('Sheet1', 'B2', false)
  assert.deepEqual(harness.highlightedPaths(), ['/Sheet1/B2'])

  harness.advanceBy(8_999)
  assert.deepEqual(harness.highlightedPaths(), ['/Sheet1/B2'])
  harness.advanceBy(1)
  assert.deepEqual(harness.highlightedPaths(), [])
})

test('preview adapter preserves sheet and scroll position when follow AI is off', () => {
  const harness = createOfficePreviewAdapterHarness()
  const before = { sheet: harness.activeSheet(), scrollTop: harness.scrollContainer.scrollTop }

  harness.emitHighlight('Sheet2', 'B2', false)

  assert.deepEqual(
    { sheet: harness.activeSheet(), scrollTop: harness.scrollContainer.scrollTop },
    before
  )
  assert.equal(
    harness.cells.find((cell) => cell.getAttribute('data-path') === '/Sheet2/B2')?.scrollCalls,
    0
  )
})

test('preview adapter restores the table viewport after an upstream full refresh', () => {
  const harness = createOfficePreviewAdapterHarness()
  const before = {
    scrollTop: harness.scrollContainer.scrollTop,
    scrollLeft: harness.scrollContainer.scrollLeft
  }

  harness.simulateFullRefresh()

  assert.deepEqual(
    {
      scrollTop: harness.scrollContainer.scrollTop,
      scrollLeft: harness.scrollContainer.scrollLeft
    },
    before
  )
})

test('preview adapter activates and scrolls to the target when follow AI is on', () => {
  const harness = createOfficePreviewAdapterHarness()
  const target = harness.cells.find((cell) => cell.getAttribute('data-path') === '/Sheet2/B2')
  assert.ok(target)

  harness.emitHighlight('Sheet2', 'B2', true)

  assert.equal(harness.activeSheet(), 'Sheet2')
  assert.equal(target.scrollCalls, 1)
})

test('preview adapter suppresses following while the preview is hidden', () => {
  const harness = createOfficePreviewAdapterHarness()
  const target = harness.cells.find((cell) => cell.getAttribute('data-path') === '/Sheet2/B2')
  assert.ok(target)
  harness.setHidden(true)

  harness.emitHighlight('Sheet2', 'B2', true)

  assert.equal(harness.activeSheet(), 'Sheet1')
  assert.equal(target.scrollCalls, 0)
})

test('preview adapter suppresses following without disturbing an active cell editor', () => {
  const harness = createOfficePreviewAdapterHarness()
  const target = harness.cells.find((cell) => cell.getAttribute('data-path') === '/Sheet2/B2')
  assert.ok(target)
  const editor = harness.focusEditor('manual draft')

  harness.emitHighlight('Sheet2', 'B2', true)

  assert.equal(harness.activeSheet(), 'Sheet1')
  assert.equal(target.scrollCalls, 0)
  assert.equal(editor.value, 'manual draft')
})

test('preview adapter keeps suppressing following after an upstream rebuild drops the cell editor', () => {
  const harness = createOfficePreviewAdapterHarness()
  const target = harness.cells.find((cell) => cell.getAttribute('data-path') === '/Sheet2/B2')
  assert.ok(target)
  const editor = harness.focusEditor('manual draft')
  // The AI patch rebuilt the sheet and removed the input before the highlight event arrived.
  harness.dropEditor(editor)

  harness.emitHighlight('Sheet2', 'B2', true)

  assert.equal(harness.activeSheet(), 'Sheet1')
  assert.equal(target.scrollCalls, 0)
})

test('preview adapter marks and follows an added worksheet tab without touching cells', () => {
  const harness = createOfficePreviewAdapterHarness()
  const tab = harness.tabs.find((candidate) => candidate.textContent === 'Sheet2')
  assert.ok(tab)

  harness.emitSheetHighlight('Sheet2', true)

  assert.equal(harness.activeSheet(), 'Sheet2')
  assert.equal(tab.classList.contains('phi-ai-highlight-tab'), true)
  assert.deepEqual(harness.highlightedPaths(), [])
})
