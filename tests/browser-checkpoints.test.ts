import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { EngineResult, EngineTabHandle } from '../src/main/browser/browser-engine'
import { InMemoryBrowserEngine } from '../src/main/browser/in-memory-browser-engine'
import {
  FileSystemBrowserCheckpointStore,
  type BrowserCheckpoint,
  type BrowserCheckpointStore
} from '../src/main/browser/browser-checkpoints'
import {
  BrowserWorkspace,
  BrowserWorkspaceDisposalError
} from '../src/main/browser/browser-workspace'
import { getSessionDir } from '../src/main/agent/session/session-store'
import { browserCapabilities, human, successful } from './helpers/browserWorkspaceHarness'

function fixture(): {
  agentDir: string
  sessionId: string
  sessionDir: string
  cleanup: () => void
} {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-browser-checkpoint-'))
  const sessionId = 'session-1'
  const sessionDir = getSessionDir(sessionId, agentDir)
  mkdirSync(sessionDir, { recursive: true })
  return { agentDir, sessionId, sessionDir, cleanup: () => rmSync(agentDir, { recursive: true }) }
}

const checkpoint: BrowserCheckpoint = {
  schemaVersion: 1,
  tabs: [
    { id: 'tab-1', title: 'First', url: 'https://first.test/' },
    { id: 'tab-2', title: 'Second', url: 'https://second.test/path' }
  ],
  activeTabId: 'tab-2'
}

test('writes and reads schema-v1 browser metadata only', () => {
  const f = fixture()
  try {
    const store = new FileSystemBrowserCheckpointStore({ agentDir: f.agentDir })
    store.save(f.sessionId, checkpoint)

    assert.deepEqual(store.load(f.sessionId), checkpoint)
    const raw = readFileSync(join(f.sessionDir, 'browser.json'), 'utf8')
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['activeTabId', 'schemaVersion', 'tabs'])
    for (const forbidden of [
      'cookie',
      'screenshot',
      'documentRevision',
      'engine-tab',
      'isAgentControlled',
      'error',
      'approval'
    ]) {
      assert.equal(raw.includes(forbidden), false)
    }
  } finally {
    f.cleanup()
  }
})

test('returns null when browser.json is absent', () => {
  const f = fixture()
  try {
    const store = new FileSystemBrowserCheckpointStore({ agentDir: f.agentDir })
    assert.equal(store.load(f.sessionId), null)
  } finally {
    f.cleanup()
  }
})

test('quarantines malformed, oversized, and invalid-schema checkpoints', () => {
  const cases: Array<{ name: string; content: string; maxBytes?: number }> = [
    { name: 'malformed', content: '{broken' },
    { name: 'oversized', content: JSON.stringify(checkpoint), maxBytes: 8 },
    { name: 'invalid-schema', content: JSON.stringify({ ...checkpoint, schemaVersion: 2 }) },
    {
      name: 'extra-sensitive-field',
      content: JSON.stringify({ ...checkpoint, cookies: ['secret'] })
    }
  ]
  for (const entry of cases) {
    const f = fixture()
    try {
      writeFileSync(join(f.sessionDir, 'browser.json'), entry.content)
      const store = new FileSystemBrowserCheckpointStore({
        agentDir: f.agentDir,
        maxBytes: entry.maxBytes,
        now: () => 123,
        randomId: () => entry.name
      })
      assert.equal(store.load(f.sessionId), null)
      assert.equal(existsSync(join(f.sessionDir, 'browser.json')), false)
      assert.deepEqual(
        readdirSync(f.sessionDir).filter((name) => name.startsWith('browser.json.corrupt-')),
        [`browser.json.corrupt-123-${entry.name}`]
      )
    } finally {
      f.cleanup()
    }
  }
})

test('rejects strict schema violations including missing active tabs and whitespace IDs', () => {
  const invalid = [
    { ...checkpoint, activeTabId: null },
    {
      schemaVersion: 1,
      tabs: [{ id: '   ', title: 'Whitespace', url: 'https://example.test/' }],
      activeTabId: '   '
    },
    { schemaVersion: 1, tabs: [], activeTabId: 'missing' }
  ]
  for (const [index, value] of invalid.entries()) {
    const f = fixture()
    try {
      writeFileSync(join(f.sessionDir, 'browser.json'), JSON.stringify(value))
      const store = new FileSystemBrowserCheckpointStore({
        agentDir: f.agentDir,
        randomId: () => `invalid-${index}`
      })
      assert.equal(store.load(f.sessionId), null)
      assert.equal(existsSync(join(f.sessionDir, 'browser.json')), false)
    } finally {
      f.cleanup()
    }
  }
})

test('normalizes invalid maxBytes options to a safe default', () => {
  for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 2.5]) {
    const f = fixture()
    try {
      const store = new FileSystemBrowserCheckpointStore({ agentDir: f.agentDir, maxBytes })
      store.save(f.sessionId, checkpoint)
      assert.deepEqual(store.load(f.sessionId), checkpoint)
    } finally {
      f.cleanup()
    }
  }
})

test('rejects oversized and over-limit metadata before creating a target or temp file', () => {
  const cases: BrowserCheckpoint[] = [
    {
      schemaVersion: 1,
      tabs: [{ id: 'tab-1', title: 'x'.repeat(5000), url: 'https://example.test/' }],
      activeTabId: 'tab-1'
    },
    {
      schemaVersion: 1,
      tabs: [{ id: 'tab-1', title: 'Title', url: `https://example.test/${'x'.repeat(20_000)}` }],
      activeTabId: 'tab-1'
    },
    {
      schemaVersion: 1,
      tabs: Array.from({ length: 101 }, (_, index) => ({
        id: `tab-${index}`,
        title: 'Title',
        url: 'https://example.test/'
      })),
      activeTabId: 'tab-0'
    }
  ]
  for (const value of cases) {
    const f = fixture()
    try {
      const store = new FileSystemBrowserCheckpointStore({ agentDir: f.agentDir, maxBytes: 128 })
      assert.throws(() => store.save(f.sessionId, value), /invalid|large/i)
      assert.deepEqual(readdirSync(f.sessionDir), [])
    } finally {
      f.cleanup()
    }
  }
})

test('uses collision-safe quarantine names', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.sessionDir, 'browser.json'), '{broken')
    writeFileSync(join(f.sessionDir, 'browser.json.corrupt-123-fixed'), 'existing')
    let id = 0
    const store = new FileSystemBrowserCheckpointStore({
      agentDir: f.agentDir,
      now: () => 123,
      randomId: () => (id++ === 0 ? 'fixed' : 'unique')
    })
    assert.equal(store.load(f.sessionId), null)
    assert.equal(
      readFileSync(join(f.sessionDir, 'browser.json.corrupt-123-fixed'), 'utf8'),
      'existing'
    )
    assert.equal(existsSync(join(f.sessionDir, 'browser.json.corrupt-123-unique')), true)
  } finally {
    f.cleanup()
  }
})

test('atomically replaces browser.json and cleans temporary siblings', () => {
  const f = fixture()
  try {
    let id = 0
    const store = new FileSystemBrowserCheckpointStore({
      agentDir: f.agentDir,
      randomId: () => `write-${++id}`
    })
    store.save(f.sessionId, checkpoint)
    store.save(f.sessionId, {
      schemaVersion: 1,
      tabs: [{ id: 'tab-3', title: 'Latest', url: 'https://latest.test/' }],
      activeTabId: 'tab-3'
    })

    assert.equal(store.load(f.sessionId)?.tabs[0].id, 'tab-3')
    assert.deepEqual(
      readdirSync(f.sessionDir).filter((name) => name.includes('.tmp-')),
      []
    )
  } finally {
    f.cleanup()
  }
})

test('removes browser.json idempotently', () => {
  const f = fixture()
  try {
    const store = new FileSystemBrowserCheckpointStore({ agentDir: f.agentDir })
    store.save(f.sessionId, checkpoint)
    store.remove(f.sessionId)
    store.remove(f.sessionId)
    assert.equal(existsSync(join(f.sessionDir, 'browser.json')), false)
  } finally {
    f.cleanup()
  }
})

class MemoryCheckpointStore implements BrowserCheckpointStore {
  readonly saves: BrowserCheckpoint[] = []
  saveAttempts = 0
  removeCalls = 0
  removeAttempts = 0
  saveError: Error | null = null
  removeError: Error | null = null

  constructor(public value: BrowserCheckpoint | null = null) {}

  load(): BrowserCheckpoint | null {
    return this.value ? structuredClone(this.value) : null
  }

  save(_sessionId: string, value: BrowserCheckpoint): void {
    this.saveAttempts += 1
    if (this.saveError) throw this.saveError
    this.value = structuredClone(value)
    this.saves.push(structuredClone(value))
  }

  remove(): void {
    this.removeAttempts += 1
    if (this.removeError) throw this.removeError
    this.value = null
    this.removeCalls += 1
  }
}

function restoredWorkspace(
  store: BrowserCheckpointStore,
  engine: InMemoryBrowserEngine = new InMemoryBrowserEngine({
    capabilities: browserCapabilities
  })
): { workspace: BrowserWorkspace; engine: InMemoryBrowserEngine } {
  return {
    engine,
    workspace: new BrowserWorkspace({
      sessionId: 'session-1',
      partition: 'browser-project-a',
      engine,
      checkpointStore: store,
      now: () => 42
    })
  }
}

test('loads idle restorable offers without creating pages or network activity', async () => {
  const store = new MemoryCheckpointStore(checkpoint)
  const { engine, workspace } = restoredWorkspace(store)
  const snapshot = workspace.snapshot()

  assert.equal(engine.hasTab('engine-tab-1' as EngineTabHandle), false)
  assert.deepEqual(
    snapshot.tabs.map(({ id, title, url, phase, restorable }) => ({
      id,
      title,
      url,
      phase,
      restorable
    })),
    checkpoint.tabs.map((tab) => ({ ...tab, phase: 'idle', restorable: true }))
  )
  assert.equal(snapshot.activeTabId, 'tab-2')

  await workspace.execute(human, {
    type: 'activate',
    requestId: 'activate-1',
    tabId: 'tab-1'
  })
  await workspace.execute(human, {
    type: 'snapshot',
    requestId: 'snapshot-1',
    tabId: 'tab-1'
  })
  assert.equal(engine.hasTab('engine-tab-1' as EngineTabHandle), false)
})

test('explicit restore lazily materializes a stable tab without changing order', async () => {
  const store = new MemoryCheckpointStore(checkpoint)
  const { engine, workspace } = restoredWorkspace(store)

  const result = await workspace.execute(human, {
    type: 'restore',
    requestId: 'restore-1',
    tabId: 'tab-1'
  })

  successful(result)
  assert.equal(engine.hasTab('engine-tab-1' as EngineTabHandle), true)
  assert.deepEqual(
    result.snapshot.tabs.map((tab) => tab.id),
    ['tab-1', 'tab-2']
  )
  assert.equal(result.snapshot.tabs[0].id, 'tab-1')
  assert.equal(result.snapshot.tabs[0].url, 'https://first.test/')
  assert.equal(result.snapshot.tabs[0].restorable, undefined)
})

test('restores the internal about:blank sentinel without navigation', async () => {
  const store = new MemoryCheckpointStore({
    schemaVersion: 1,
    tabs: [{ id: 'blank-tab', title: 'New tab', url: 'about:blank' }],
    activeTabId: 'blank-tab'
  })
  const { engine, workspace } = restoredWorkspace(store)
  const result = await workspace.execute(human, {
    type: 'restore',
    requestId: 'restore-blank',
    tabId: 'blank-tab'
  })

  successful(result)
  const handle = 'engine-tab-1' as EngineTabHandle
  assert.equal(engine.hasTab(handle), true)
  assert.deepEqual(engine.recordedActions(handle), [])
  assert.equal(result.snapshot.tabs[0].url, 'about:blank')
  assert.equal(result.snapshot.tabs[0].restorable, undefined)

  const unsafeStore = new MemoryCheckpointStore({
    schemaVersion: 1,
    tabs: [{ id: 'unsafe-tab', title: 'Unsafe', url: 'about:config' }],
    activeTabId: 'unsafe-tab'
  })
  const unsafe = restoredWorkspace(unsafeStore)
  const denied = await unsafe.workspace.execute(human, {
    type: 'restore',
    requestId: 'restore-unsafe',
    tabId: 'unsafe-tab'
  })
  assert.equal(denied.ok, false)
  assert.equal(unsafe.engine.hasTab(handle), false)
})

test('navigate on a restored tab materializes it with the new validated URL', async () => {
  const store = new MemoryCheckpointStore(checkpoint)
  const { workspace } = restoredWorkspace(store)
  const result = await workspace.execute(human, {
    type: 'navigate',
    requestId: 'navigate-1',
    tabId: 'tab-2',
    url: 'replacement.test'
  })

  successful(result)
  assert.equal(result.snapshot.tabs[1].id, 'tab-2')
  assert.equal(result.snapshot.tabs[1].url, 'https://replacement.test/')
  assert.equal(result.snapshot.tabs[1].restorable, undefined)
})

test('restore rollback returns to the restorable offer after throw or cancellation', async () => {
  class RestoreFailureEngine extends InMemoryBrowserEngine {
    mode: 'throw' | 'cancel' = 'throw'
    override async execute(): Promise<EngineResult> {
      if (this.mode === 'throw') throw new Error('restore failed')
      return {
        ok: false,
        error: { code: 'ACTION_CANCELLED', message: 'Browser action was cancelled' }
      }
    }
  }
  const engine = new RestoreFailureEngine({ capabilities: browserCapabilities })
  const { workspace } = restoredWorkspace(new MemoryCheckpointStore(checkpoint), engine)
  const thrown = await workspace.execute(human, {
    type: 'restore',
    requestId: 'restore-throw',
    tabId: 'tab-1'
  })
  assert.equal(thrown.ok, false)
  assert.equal(workspace.snapshot().tabs[0].restorable, true)
  assert.equal(engine.hasTab('engine-tab-1' as EngineTabHandle), false)

  engine.mode = 'cancel'
  const cancelled = await workspace.execute(human, {
    type: 'restore',
    requestId: 'restore-cancel',
    tabId: 'tab-1'
  })
  assert.equal(cancelled.ok, false)
  assert.equal(workspace.snapshot().tabs[0].restorable, true)
})

test('genuine restore navigation failure may remain as a materialized failed tab', async () => {
  class FailedRestoreEngine extends InMemoryBrowserEngine {
    override async execute(): Promise<EngineResult> {
      return {
        ok: false,
        error: { code: 'NAVIGATION_FAILED', message: 'raw unsafe error' }
      }
    }
  }
  const engine = new FailedRestoreEngine({ capabilities: browserCapabilities })
  const { workspace } = restoredWorkspace(new MemoryCheckpointStore(checkpoint), engine)
  const failed = await workspace.execute(human, {
    type: 'restore',
    requestId: 'restore-1',
    tabId: 'tab-1'
  })

  assert.equal(failed.ok, false)
  assert.equal(failed.snapshot.tabs[0].phase, 'failed')
  assert.equal(failed.snapshot.tabs[0].restorable, undefined)
  assert.equal(failed.snapshot.tabs[0].error?.message, 'Page failed to load')
})

test('generated tab IDs skip restored ID collisions', async () => {
  const store = new MemoryCheckpointStore({
    schemaVersion: 1,
    tabs: [{ id: 'browser-tab-1', title: 'Saved', url: 'https://saved.test/' }],
    activeTabId: 'browser-tab-1'
  })
  const { workspace } = restoredWorkspace(store)
  const result = await workspace.execute(human, { type: 'newTab', requestId: 'new-1' })
  successful(result)
  assert.deepEqual(
    result.snapshot.tabs.map((tab) => tab.id),
    ['browser-tab-1', 'browser-tab-2']
  )
})

test('persists only metadata changes and removes the checkpoint after closing the last tab', async () => {
  const store = new MemoryCheckpointStore()
  const engine = new InMemoryBrowserEngine({ capabilities: browserCapabilities })
  const { workspace } = restoredWorkspace(store, engine)
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'example.test' })
  const savesAfterOpen = store.saves.length
  engine.emitLoading('engine-tab-1' as EngineTabHandle, true)
  engine.emitLoading('engine-tab-1' as EngineTabHandle, false)
  engine.emitCrash('engine-tab-1' as EngineTabHandle, 'killed')
  assert.equal(store.saves.length, savesAfterOpen)

  engine.emitTitle('engine-tab-1' as EngineTabHandle, 'Changed title')
  assert.equal(store.saves.length, savesAfterOpen + 1)
  await workspace.execute(human, {
    type: 'close',
    requestId: 'close-1',
    tabId: 'browser-tab-1'
  })
  assert.equal(store.removeCalls, 1)
})

test('checkpoint persistence failures keep commands successful and emit only safe errors', async () => {
  const store = new MemoryCheckpointStore()
  store.saveError = new Error('raw filesystem secret')
  const engine = new InMemoryBrowserEngine({ capabilities: browserCapabilities })
  const { workspace } = restoredWorkspace(store, engine)
  const errors: string[] = []
  workspace.subscribe((event) => {
    if (event.type === 'error') errors.push(JSON.stringify(event.error))
  })

  const opened = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-1',
    url: 'example.test'
  })
  successful(opened)
  assert.equal(opened.snapshot.tabs.length, 1)
  assert.equal(errors.length > 0, true)
  assert.equal(
    errors.some((error) => error.includes('raw filesystem secret')),
    false
  )
  const attempts = store.saveAttempts
  engine.emitLoading('engine-tab-1' as EngineTabHandle, true)
  engine.emitLoading('engine-tab-1' as EngineTabHandle, false)
  assert.equal(store.saveAttempts, attempts)
})

test('oversized remote metadata cannot break events or reach the checkpoint store', async () => {
  const store = new MemoryCheckpointStore()
  const engine = new InMemoryBrowserEngine({ capabilities: browserCapabilities })
  const { workspace } = restoredWorkspace(store, engine)
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'example.test' })
  const attempts = store.saveAttempts
  const errors: string[] = []
  workspace.subscribe((event) => {
    if (event.type === 'error') errors.push(JSON.stringify(event.error))
  })
  const hugeTitle = 'x'.repeat(100_000)

  assert.doesNotThrow(() => engine.emitTitle('engine-tab-1' as EngineTabHandle, hugeTitle))
  assert.doesNotThrow(() => engine.emitTitle('engine-tab-1' as EngineTabHandle, hugeTitle))
  assert.equal(workspace.snapshot().tabs[0].title, hugeTitle)
  assert.equal(store.saveAttempts, attempts)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].includes('x'.repeat(100)), false)
})

test('checkpoint removal failures do not prevent closing the last tab', async () => {
  const store = new MemoryCheckpointStore()
  const { workspace } = restoredWorkspace(store)
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'example.test' })
  store.removeError = new Error('raw removal secret')
  const errors: string[] = []
  workspace.subscribe((event) => {
    if (event.type === 'error') errors.push(JSON.stringify(event.error))
  })

  const closed = await workspace.execute(human, {
    type: 'close',
    requestId: 'close-1',
    tabId: 'browser-tab-1'
  })

  successful(closed)
  assert.deepEqual(closed.snapshot.tabs, [])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].includes('raw removal secret'), false)
})

test('dispose retries a temporary checkpoint removal failure before shutdown', async () => {
  const store = new MemoryCheckpointStore()
  const { workspace } = restoredWorkspace(store)
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'example.test' })
  store.removeError = new Error('temporary removal failure')
  await workspace.execute(human, {
    type: 'close',
    requestId: 'close-1',
    tabId: 'browser-tab-1'
  })
  assert.notEqual(store.value, null)

  store.removeError = null
  await workspace.dispose()
  const fresh = restoredWorkspace(store)
  assert.deepEqual(fresh.workspace.snapshot().tabs, [])
})

test('dispose reports a safe checkpoint flush error while still disposing the engine', async () => {
  class CountingEngine extends InMemoryBrowserEngine {
    disposeCalls = 0
    override async dispose(): Promise<void> {
      this.disposeCalls += 1
      await super.dispose()
    }
  }
  const store = new MemoryCheckpointStore()
  const engine = new CountingEngine({ capabilities: browserCapabilities })
  const { workspace } = restoredWorkspace(store, engine)
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'example.test' })
  store.removeError = new Error('raw permanent removal failure')
  await workspace.execute(human, {
    type: 'close',
    requestId: 'close-1',
    tabId: 'browser-tab-1'
  })

  await assert.rejects(
    workspace.dispose(),
    (error: BrowserWorkspaceDisposalError) =>
      error.failures.engine === false &&
      error.failures.checkpoint === true &&
      !error.message.includes('raw permanent removal failure')
  )
  assert.equal(engine.disposeCalls, 1)
})

test('dispose reports engine-only and dual failures without masking categories', async () => {
  class FailingEngine extends InMemoryBrowserEngine {
    disposeCalls = 0
    override async dispose(): Promise<void> {
      this.disposeCalls += 1
      throw new Error('raw engine disposal secret')
    }
  }

  const engineOnlyStore = new MemoryCheckpointStore()
  const engineOnlyEngine = new FailingEngine({ capabilities: browserCapabilities })
  const engineOnly = restoredWorkspace(engineOnlyStore, engineOnlyEngine).workspace
  await engineOnly.execute(human, { type: 'open', requestId: 'open-1', url: 'example.test' })
  await assert.rejects(
    engineOnly.dispose(),
    (error: BrowserWorkspaceDisposalError) =>
      error.failures.engine === true &&
      error.failures.checkpoint === false &&
      !error.message.includes('raw engine disposal secret')
  )

  const dualStore = new MemoryCheckpointStore()
  const dualEngine = new FailingEngine({ capabilities: browserCapabilities })
  const dual = restoredWorkspace(dualStore, dualEngine).workspace
  await dual.execute(human, { type: 'open', requestId: 'open-1', url: 'example.test' })
  dualStore.removeError = new Error('raw checkpoint disposal secret')
  await dual.execute(human, {
    type: 'close',
    requestId: 'close-1',
    tabId: 'browser-tab-1'
  })
  await assert.rejects(
    dual.dispose(),
    (error: BrowserWorkspaceDisposalError) =>
      error.failures.engine === true &&
      error.failures.checkpoint === true &&
      !error.message.includes('raw engine disposal secret') &&
      !error.message.includes('raw checkpoint disposal secret')
  )
  assert.equal(engineOnlyEngine.disposeCalls, 1)
  assert.equal(dualEngine.disposeCalls, 1)
  assert.equal(dualStore.removeAttempts, 2)
})
