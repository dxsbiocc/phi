import assert from 'node:assert/strict'
import test from 'node:test'
import { createBeforeQuitHandler, type PreventableQuitEvent } from '../src/main/app-quit'

interface FakeBrowser {
  state: { isQuitting: boolean; willQuitEmitted: boolean; quitCalls: number }
  quit: () => Promise<void>
  setListener: (next: (event: PreventableQuitEvent) => void) => void
}

/**
 * Mirrors Electron's Browser::Quit: emit `before-quit`, drain microtasks (as the
 * JS callback scope closes), then record `isQuitting = !prevented`. A quit that
 * was started by a nested call gets cleared by the outer, prevented one.
 */
function createFakeBrowser(): FakeBrowser {
  const state = { isQuitting: false, willQuitEmitted: false, quitCalls: 0 }
  let listener: (event: PreventableQuitEvent) => void = () => undefined
  let draining = false

  async function quit(): Promise<void> {
    state.quitCalls += 1
    let prevented = false
    listener({ preventDefault: () => (prevented = true) })
    const settle = (): void => {
      state.isQuitting = !prevented
      if (!state.isQuitting) return
      // Windows close asynchronously; all-closed while quitting emits will-quit.
      setImmediate(() => {
        if (state.isQuitting) state.willQuitEmitted = true
      })
    }
    // A quit nested inside an outer drain finishes synchronously in Electron.
    if (draining) return settle()
    draining = true
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
    draining = false
    settle()
  }

  return {
    state,
    quit,
    setListener: (next) => {
      listener = next
    }
  }
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('quit completes when cleanup settles inside the before-quit microtask drain', async () => {
  const browser = createFakeBrowser()
  let beginShutdownCalls = 0
  browser.setListener(
    createBeforeQuitHandler({
      beginShutdown: () => (beginShutdownCalls += 1),
      cleanup: () => Promise.resolve(),
      quit: () => void browser.quit(),
      timeoutMs: 2_000
    })
  )

  await browser.quit()
  for (let i = 0; i < 5; i += 1) await nextMacrotask()

  assert.equal(beginShutdownCalls, 1)
  assert.equal(browser.state.quitCalls, 2)
  assert.equal(browser.state.isQuitting, true)
  assert.equal(browser.state.willQuitEmitted, true)
})

test('resumed quit never runs synchronously after cleanup settles', async () => {
  const deferred: Array<() => void> = []
  let quitCalls = 0
  const handler = createBeforeQuitHandler({
    beginShutdown: () => undefined,
    cleanup: () => Promise.resolve(),
    quit: () => (quitCalls += 1),
    timeoutMs: 2_000,
    defer: (resume) => deferred.push(resume)
  })

  let prevented = false
  handler({ preventDefault: () => (prevented = true) })
  for (let i = 0; i < 20; i += 1) await Promise.resolve()

  assert.equal(prevented, true)
  assert.equal(quitCalls, 0)
  assert.equal(deferred.length, 1)
  deferred[0]()
  assert.equal(quitCalls, 1)

  let preventedAgain = false
  handler({ preventDefault: () => (preventedAgain = true) })
  assert.equal(preventedAgain, false)
})

test('quit resumes after the timeout when cleanup hangs or throws', async () => {
  for (const cleanup of [
    () => new Promise<void>(() => undefined),
    () => {
      throw new Error('boom')
    }
  ]) {
    let quitCalls = 0
    const handler = createBeforeQuitHandler({
      beginShutdown: () => undefined,
      cleanup,
      quit: () => (quitCalls += 1),
      timeoutMs: 20
    })
    handler({ preventDefault: () => undefined })
    handler({ preventDefault: () => undefined })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(quitCalls, 1)
  }
})
