import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

import { IPC } from '../src/shared/ipcChannels'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { analysisCopy } from '../src/renderer/src/features/analysis/lib/analysisUiCopy'
import * as runtimeUtils from '../src/renderer/src/features/analysis/lib/analysisNotebookRuntimeUtils'
import { pollJupyterServerStartupStatus } from '../src/renderer/src/features/runtime/lib/jupyterStatusPolling'
import * as notebookSession from '../src/renderer/src/features/analysis/lib/notebookSession'
import * as notebookDocument from '../src/shared/notebookDocument'
import * as executionMetadata from '../src/shared/notebookExecutionMetadata'
import type {
  AnalysisNotebookFile,
  JupyterServerStatus,
  RendererApi
} from '../src/renderer/src/types'
import type { AnalysisNotebookRuntimeState } from '../src/renderer/src/features/analysis/lib/analysisNotebookRuntimeTypes'
import { AnalysisNotebookFileWatcher } from '../src/main/agent/notebook/analysis-notebook-watch'

setUiLanguage('zh-CN')

type Cleanup = (() => void) | void
type Slot = { value?: unknown; dependencies?: unknown[]; cleanup?: Cleanup }

// Execute the real hook with a deterministic hook scheduler and renderer boundary.
function runtimeHarness(): {
  readonly state: AnalysisNotebookRuntimeState
  calls: {
    refresh: number
    open: number
    startJupyter: number
    execute: number
    sync: Array<{ document: unknown; revision: string }>
  }
  setDisk: (file: AnalysisNotebookFile) => void
  setSave: (callback: RendererApi['saveAnalysisNotebook']) => void
  setRefresh: (callback: () => Promise<AnalysisNotebookFile>) => void
  setJupyterStatus: (status: JupyterServerStatus) => void
  setStartJupyter: (callback: RendererApi['startAnalysisJupyter']) => void
  setExecute: (callback: RendererApi['executeAnalysisNotebookCell']) => void
  switchCwd: (value: string) => void
  activate: (file: AnalysisNotebookFile) => Promise<void>
  focus: () => Promise<void>
  advance: () => Promise<void>
  flush: () => Promise<AnalysisNotebookRuntimeState>
  dispose: () => void
} {
  const path = 'src/renderer/src/features/analysis/hooks/useAnalysisNotebookRuntime.ts'
  const syntax = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = syntax.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'useAnalysisNotebookRuntime'
  )
  assert.ok(declaration)
  const code = ts.transpileModule(declaration.getText(syntax).replace(/^export /, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const slots: Slot[] = []
  let index = 0
  let changed = false
  let cwd = '/project'
  const effects: Array<() => void> = []
  const timers = new Map<number, () => void>()
  let timerId = 0
  const browser = new EventTarget()
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  Object.assign(browser, {
    setTimeout: (action: () => void) => {
      timers.set(++timerId, action)
      return timerId
    },
    clearTimeout: (id: number) => timers.delete(id)
  })
  const calls = {
    refresh: 0,
    open: 0,
    startJupyter: 0,
    execute: 0,
    sync: [] as Array<{ document: unknown; revision: string }>
  }
  let jupyterStatus: JupyterServerStatus = {
    projectCwd: cwd,
    state: 'stopped',
    runtimeKind: 'ssh',
    hasEndpoint: false
  }
  let disk = notebookFile('disk')
  let save: RendererApi['saveAnalysisNotebook'] = async (_cwd, input) => ({
    ...disk,
    document: input.document,
    savedRevision: input.document.revision,
    contentHash: `saved:${input.document.revision}`
  })
  let refresh = async (): Promise<AnalysisNotebookFile> => disk
  let startJupyter: RendererApi['startAnalysisJupyter'] = async () => {
    jupyterStatus = { ...jupyterStatus, state: 'ready', hasEndpoint: true }
    return jupyterStatus
  }
  let execute: RendererApi['executeAnalysisNotebookCell'] = async (
    projectCwd,
    notebookPath,
    document,
    cellId
  ) => ({
    cellId,
    executionCount: 1,
    outputs: [],
    state: 'idle',
    startedAt: '2026-10-22T00:00:00Z',
    completedAt: '2026-10-22T00:00:01Z',
    document,
    sessionStatus: { projectCwd, notebookPath, state: 'idle' }
  })
  const api = {
    openAnalysisNotebook: async () => {
      calls.open += 1
      return refresh()
    },
    refreshAnalysisNotebook: async () => {
      calls.refresh += 1
      return refresh()
    },
    saveAnalysisNotebook: (
      ...args: Parameters<RendererApi['saveAnalysisNotebook']>
    ): Promise<AnalysisNotebookFile> => save(...args),
    syncAnalysisNotebookDraft: async (
      _cwd: string,
      _path: string,
      nextDocument: unknown,
      revision: string
    ) => {
      calls.sync.push({ document: nextDocument, revision })
    },
    listAnalysisNotebooks: async () => ({ projectCwd: cwd, notebooks: [] }),
    listAnalysisKernels: async () => ({ kernels: [] }),
    getAnalysisJupyterStatus: async () => jupyterStatus,
    startAnalysisJupyter: async (projectCwd: string) => {
      calls.startJupyter += 1
      return startJupyter(projectCwd)
    },
    executeAnalysisNotebookCell: (
      ...args: Parameters<RendererApi['executeAnalysisNotebookCell']>
    ) => {
      calls.execute += 1
      return execute(...args)
    },
    getAnalysisNotebookSessionStatus: async () => ({ state: 'idle' })
  }
  const slot = (): Slot => (slots[index++] ??= {})
  const equal = (left: unknown[] | undefined, right: unknown[] | undefined): boolean =>
    Boolean(
      left &&
      right &&
      left.length === right.length &&
      left.every((value, i) => Object.is(value, right[i]))
    )
  const hook = runInNewContext(`${code}\nuseAnalysisNotebookRuntime`, {
    analysisCopy,
    ...runtimeUtils,
    pollJupyterServerStartupStatus,
    ...notebookSession,
    ...notebookDocument,
    ...executionMetadata,
    readableErrorMessage: (error: unknown, fallback: string) =>
      error instanceof Error ? error.message : fallback,
    window: browser,
    document,
    useState: (initial: unknown) => {
      const current = slot()
      if (!('value' in current)) current.value = initial
      return [
        current.value,
        (next: unknown) => {
          const value = typeof next === 'function' ? next(current.value) : next
          changed ||= !Object.is(current.value, value)
          current.value = value
        }
      ]
    },
    useRef: (initial: unknown) => {
      const current = slot()
      current.value ??= { current: initial }
      return current.value
    },
    useCallback: (callback: unknown, dependencies: unknown[]) => {
      const current = slot()
      if (!equal(current.dependencies, dependencies)) {
        current.value = callback
        current.dependencies = dependencies
      }
      return current.value
    },
    useEffect: (effect: () => Cleanup, dependencies?: unknown[]) => {
      const current = slot()
      if (equal(current.dependencies, dependencies)) return
      current.dependencies = dependencies
      effects.push(() => {
        current.cleanup?.()
        current.cleanup = effect()
      })
    }
  }) as (deps: unknown) => AnalysisNotebookRuntimeState
  const deps = {
    rendererApi: api,
    getActiveCwd: () => cwd,
    projectsRef: { current: [] },
    showSnackbar: () => {},
    onNavigateToNotebookView: () => {}
  }
  let state: AnalysisNotebookRuntimeState
  const render = (): AnalysisNotebookRuntimeState => {
    index = 0
    changed = false
    state = hook(deps)
    effects.splice(0).forEach((effect) => effect())
    return state
  }
  const flush = async (): Promise<AnalysisNotebookRuntimeState> => {
    for (let turn = 0; turn < 8; turn += 1) {
      if (changed) render()
      await Promise.resolve()
    }
    return state
  }
  render()
  return {
    get state() {
      return state
    },
    calls,
    setDisk: (file: AnalysisNotebookFile) => {
      disk = file
    },
    setSave: (callback: typeof save) => {
      save = callback
    },
    setRefresh: (callback: typeof refresh) => {
      refresh = callback
    },
    setJupyterStatus: (status: JupyterServerStatus) => {
      jupyterStatus = status
    },
    setStartJupyter: (callback: typeof startJupyter) => {
      startJupyter = callback
    },
    setExecute: (callback: typeof execute) => {
      execute = callback
    },
    switchCwd: (value: string) => {
      cwd = value
    },
    activate: async (file: AnalysisNotebookFile) => {
      state.setActiveAnalysisNotebook(file)
      await flush()
    },
    focus: async () => {
      browser.dispatchEvent(new Event('focus'))
      await flush()
    },
    advance: async () => {
      const pending = [...timers.values()]
      timers.clear()
      pending.forEach((action) => action())
      await flush()
    },
    flush,
    dispose: () => {
      slots.forEach((current) => current.cleanup?.())
      timers.clear()
    }
  }
}

function notebookFile(source: string, name = 'qc'): AnalysisNotebookFile {
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      { id: 'cell-1', cell_type: 'code', source, execution_count: null, outputs: [], metadata: {} }
    ]
  })
  return {
    path: `/project/notebooks/${name}.ipynb`,
    relativePath: `notebooks/${name}.ipynb`,
    name: `${name}.ipynb`,
    bytes: source.length,
    modifiedAt: '2026-10-15T00:00:00Z',
    savedRevision: document.revision,
    contentHash: `disk:${source}`,
    document
  }
}

function changed(
  file: AnalysisNotebookFile,
  projectCwd = '/project'
): import('../src/renderer/src/types').AnalysisNotebookFileChange {
  return {
    type: 'changed' as const,
    projectCwd,
    path: file.path,
    relativePath: file.relativePath,
    file
  }
}

test('running a cell with stopped remote Jupyter opens a start dialog without changing the cell', async () => {
  const runtime = runtimeHarness()
  const file = notebookFile('print("unchanged")')
  await runtime.activate(file)

  await runtime.state.onRunAnalysisNotebookCell(file, file.document, 'cell-1')
  await runtime.flush()
  assert.equal(runtime.state.pendingJupyterCellStart?.cwd, '/project')
  assert.equal(runtime.state.pendingJupyterCellStart?.notebookPath, file.path)
  assert.equal(runtime.state.pendingJupyterCellStart?.cellId, 'cell-1')
  assert.equal(runtime.state.pendingJupyterCellStart?.runtimeKind, 'ssh')
  assert.equal(runtime.state.activeAnalysisNotebook, file)
  assert.equal(runtime.state.analysisCellExecutionError, null)
  assert.equal(runtime.calls.execute, 0)

  await runtime.state.onStartJupyterForPendingCell()
  await runtime.flush()
  assert.equal(runtime.calls.startJupyter, 1)
  assert.equal(runtime.state.pendingJupyterCellStart, null)
  assert.equal(runtime.calls.execute, 0, 'starting Jupyter must not execute stale cell code')

  await runtime.state.onRunAnalysisNotebookCell(file, file.document, 'cell-1')
  await runtime.flush()
  assert.equal(runtime.calls.execute, 1)
  runtime.dispose()
})

test('a failed one-click Jupyter start keeps the cell unchanged and the dialog actionable', async () => {
  const runtime = runtimeHarness()
  const file = notebookFile('print("not run")')
  await runtime.activate(file)
  runtime.setStartJupyter(async () => {
    throw new Error('Server environment is unavailable')
  })

  await runtime.state.onRunAnalysisNotebookCell(file, file.document, 'cell-1')
  await runtime.flush()
  await runtime.state.onStartJupyterForPendingCell()
  await runtime.flush()
  assert.equal(runtime.calls.startJupyter, 1)
  assert.equal(runtime.calls.execute, 0)
  assert.equal(runtime.state.pendingJupyterCellStart?.cellId, 'cell-1')
  assert.match(runtime.state.analysisJupyterError ?? '', /environment is unavailable/)
  assert.equal(runtime.state.activeAnalysisNotebook, file)
  runtime.dispose()
})

test('a stopped Jupyter race after execution begins opens the dialog without writing an error output', async () => {
  const runtime = runtimeHarness()
  const file = notebookFile('print("retry")')
  await runtime.activate(file)
  runtime.setJupyterStatus({
    projectCwd: '/project',
    state: 'ready',
    runtimeKind: 'ssh',
    hasEndpoint: true
  })
  await runtime.state.refreshAnalysisJupyterStatus()
  await runtime.flush()
  runtime.setExecute(async () => {
    runtime.setJupyterStatus({
      projectCwd: '/project',
      state: 'stopped',
      runtimeKind: 'ssh',
      hasEndpoint: false
    })
    throw new Error('remote server stopped')
  })

  await runtime.state.onRunAnalysisNotebookCell(file, file.document, 'cell-1')
  await runtime.flush()
  assert.equal(runtime.state.pendingJupyterCellStart?.cellId, 'cell-1')
  assert.equal(runtime.state.pendingJupyterCellStart?.runtimeKind, 'ssh')
  assert.equal(runtime.state.activeAnalysisNotebook, file)
  assert.equal(runtime.state.analysisCellExecutionError, null)
  assert.equal(runtime.calls.execute, 1)
  runtime.dispose()
})

test('file events refresh a clean notebook and the cached inactive file', async () => {
  const runtime = runtimeHarness()
  const original = notebookFile('original')
  await runtime.activate(original)
  runtime.state.handleNotebookFileChanged(changed(notebookFile('external')))
  await runtime.flush()
  assert.equal(runtime.state.activeAnalysisNotebook?.document.cells[0].source, 'external')
  await runtime.activate(notebookFile('other', 'other'))
  runtime.state.handleNotebookFileChanged(changed(notebookFile('new external')))
  await runtime.flush()
  runtime.state.activateCachedAnalysisNotebook(original.path)
  await runtime.flush()
  assert.equal(runtime.state.activeAnalysisNotebook?.document.cells[0].source, 'new external')
  runtime.dispose()
})

test('external refresh preserves edits registered before the draft IPC debounce', async () => {
  const runtime = runtimeHarness()
  const original = notebookFile('original')
  await runtime.activate(original)
  await runtime.state.onSyncAnalysisNotebookDraft(original, notebookFile('local edit').document)
  runtime.state.handleNotebookFileChanged(changed(notebookFile('external edit')))
  await runtime.flush()
  assert.equal(runtime.state.activeAnalysisNotebook?.document.cells[0].source, 'local edit')
  assert.match(runtime.state.analysisNotebookContentError ?? '', /磁盘|冲突/)
  assert.equal(runtime.calls.sync.length, 0, 'only the local dirty marker is immediate')
  runtime.dispose()
})

test('save acknowledgements keep later edits and return the disk revision for the next save', async () => {
  const runtime = runtimeHarness()
  const original = notebookFile('original')
  await runtime.activate(original)
  let acknowledge!: (file: AnalysisNotebookFile) => void
  runtime.setSave(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve
      })
  )
  const firstEdit = notebookFile('first edit')
  await runtime.state.onSyncAnalysisNotebookDraft(original, firstEdit.document)
  const pending = runtime.state.onSaveAnalysisNotebook(original, firstEdit.document)
  await runtime.state.onSyncAnalysisNotebookDraft(original, notebookFile('later edit').document)
  acknowledge(firstEdit)
  const saved = await pending
  await runtime.flush()
  assert.ok(saved && typeof saved === 'object')
  assert.equal(saved.savedRevision, firstEdit.savedRevision)
  assert.equal(runtime.state.activeAnalysisNotebook?.document.cells[0].source, 'later edit')
  assert.equal(runtime.state.activeAnalysisNotebook?.savedRevision, firstEdit.savedRevision)
  await runtime.advance()
  assert.equal(runtime.calls.sync.at(-1)?.revision, firstEdit.savedRevision)
  runtime.dispose()
})

test('a delayed save updates its cache without replacing the active notebook', async () => {
  const runtime = runtimeHarness()
  const original = notebookFile('original')
  await runtime.activate(original)
  let acknowledge!: (file: AnalysisNotebookFile) => void
  runtime.setSave(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve
      })
  )
  const pending = runtime.state.onSaveAnalysisNotebook(original, original.document)
  await runtime.activate(notebookFile('other', 'other'))
  acknowledge(notebookFile('saved'))
  await pending
  await runtime.flush()
  assert.equal(runtime.state.activeAnalysisNotebook?.name, 'other.ipynb')
  runtime.state.activateCachedAnalysisNotebook(original.path)
  await runtime.flush()
  assert.equal(runtime.state.activeAnalysisNotebook?.document.cells[0].source, 'saved')
  runtime.dispose()
})

test('focus revalidates with the read-only API and ignores a response superseded by editing', async () => {
  const runtime = runtimeHarness()
  const original = notebookFile('original')
  await runtime.activate(original)
  runtime.setDisk(notebookFile('disk update'))
  await runtime.focus()
  assert.equal(runtime.state.activeAnalysisNotebook?.document.cells[0].source, 'disk update')
  assert.equal(runtime.calls.open, 0)
  let respond!: (file: AnalysisNotebookFile) => void
  runtime.setRefresh(
    () =>
      new Promise((resolve) => {
        respond = resolve
      })
  )
  await runtime.focus()
  const current = runtime.state.activeAnalysisNotebook!
  await runtime.state.onSyncAnalysisNotebookDraft(current, notebookFile('typing').document)
  respond(notebookFile('stale disk'))
  await runtime.flush()
  runtime.state.activateCachedAnalysisNotebook(current.path)
  await runtime.flush()
  assert.equal(runtime.state.activeAnalysisNotebook?.document.cells[0].source, 'typing')
  const calls = runtime.calls.refresh
  await runtime.focus()
  assert.equal(runtime.calls.refresh, calls, 'dirty notebooks do not read over local edits')
  runtime.dispose()
})

test('closing invalidates pending opens and old project events cannot match by relative path', async () => {
  const runtime = runtimeHarness()
  let respond!: (file: AnalysisNotebookFile) => void
  runtime.setRefresh(
    () =>
      new Promise((resolve) => {
        respond = resolve
      })
  )
  const pending = runtime.state.onOpenAnalysisNotebook('notebooks/qc.ipynb')
  runtime.state.closeActiveNotebook()
  respond(notebookFile('late open'))
  await pending
  await runtime.flush()
  assert.equal(runtime.state.activeAnalysisNotebook, null)
  await runtime.state.refreshAnalysisNotebooks()
  await runtime.flush()
  runtime.switchCwd('/other-project')
  runtime.state.resetAnalysisJupyterRuntimeForCwdChange()
  await runtime.activate({ ...notebookFile('other'), path: '/other-project/notebooks/qc.ipynb' })
  runtime.state.handleNotebookFileChanged(changed(notebookFile('old project')))
  const latest = await runtime.flush()
  assert.equal(latest.activeAnalysisNotebook?.document.cells[0].source, 'other')
  runtime.dispose()
})

test('late saves keep the original project even when a queued flush starts after switching', async () => {
  const runtime = runtimeHarness()
  const original = notebookFile('original')
  await runtime.activate(original)
  runtime.switchCwd('/other-project')
  runtime.state.resetAnalysisJupyterRuntimeForCwdChange()
  await runtime.activate({ ...notebookFile('other'), path: '/other-project/notebooks/qc.ipynb' })
  let savedCwd: string | undefined
  runtime.setSave(async (cwd, input) => {
    savedCwd = cwd
    return { ...original, document: input.document, savedRevision: input.document.revision }
  })
  await runtime.state.onSaveAnalysisNotebook(original, notebookFile('queued old edit').document)
  await runtime.flush()
  assert.equal(savedCwd, '/project')
  assert.equal(runtime.state.activeAnalysisNotebook?.document.cells[0].source, 'other')
  runtime.dispose()
})

test('a self-save event acknowledges the saved basis without clearing a newer local edit', async () => {
  const runtime = runtimeHarness()
  const original = notebookFile('original')
  const saved = notebookFile('first edit')
  await runtime.activate(original)
  let acknowledge!: (file: AnalysisNotebookFile) => void
  runtime.setSave(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve
      })
  )
  const pending = runtime.state.onSaveAnalysisNotebook(original, saved.document)
  await runtime.state.onSyncAnalysisNotebookDraft(original, notebookFile('later edit').document)
  runtime.state.handleNotebookFileChanged(changed(saved))
  await runtime.flush()
  assert.equal(runtime.state.activeAnalysisNotebook?.document.cells[0].source, 'later edit')
  assert.equal(runtime.state.activeAnalysisNotebook?.savedRevision, saved.savedRevision)
  assert.equal(runtime.state.analysisNotebookContentError, null)
  acknowledge(saved)
  await pending
  runtime.state.handleNotebookFileChanged(changed(saved))
  await runtime.flush()
  assert.equal(runtime.state.activeAnalysisNotebook?.document.cells[0].source, 'later edit')
  runtime.dispose()
})

test('agent draft adoption stays live while a genuinely newer local edit is protected', async () => {
  const runtime = runtimeHarness()
  const original = notebookFile('original')
  await runtime.activate(original)
  const agentChange = (source: string): void =>
    runtime.state.handleNotebookDraftChanged({
      source: 'agent',
      projectCwd: '/project',
      path: original.path,
      relativePath: original.relativePath,
      document: notebookFile(source).document,
      savedRevision: original.savedRevision,
      contentHash: original.contentHash,
      changeKind: 'inserted'
    })
  await runtime.state.onSyncAnalysisNotebookDraft(original, original.document)
  agentChange('first AI edit')
  await runtime.flush()
  const first = runtime.state.activeAnalysisNotebook!
  await runtime.state.onSyncAnalysisNotebookDraft(first, first.document)
  agentChange('second AI edit')
  await runtime.flush()
  assert.equal(runtime.state.activeAnalysisNotebook?.document.cells[0].source, 'second AI edit')
  await runtime.state.onSyncAnalysisNotebookDraft(
    runtime.state.activeAnalysisNotebook!,
    notebookFile('new local edit').document
  )
  agentChange('older AI draft')
  await runtime.flush()
  assert.equal(runtime.state.activeAnalysisNotebook?.document.cells[0].source, 'new local edit')
  assert.match(runtime.state.analysisNotebookContentError ?? '', /冲突/)
  runtime.dispose()
})

test('an external on-disk AI edit reaches the active document through the real file watcher', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-notebook-refresh-')))
  const runtime = runtimeHarness()
  runtime.switchCwd(root)
  mkdirSync(join(root, 'notebooks'))
  const path = join(root, 'notebooks/qc.ipynb')
  writeFileSync(
    path,
    JSON.stringify(notebookDocument.serializeNotebook(notebookFile('original').document))
  )
  let notify!: (eventType: string, filename: string | Buffer | null) => void
  let resolveChange!: () => void
  const applied = new Promise<void>((resolve) => {
    resolveChange = resolve
  })
  const watcher = new AnalysisNotebookFileWatcher({
    debounceMs: 0,
    watchDirectory: (_directory, callback) => {
      notify = callback
      return { close: () => {} }
    },
    onChange: (event) => {
      runtime.state.handleNotebookFileChanged(event)
      resolveChange()
    }
  })
  try {
    await runtime.activate(watcher.watch(root, path))
    writeFileSync(
      path,
      JSON.stringify(
        notebookDocument.serializeNotebook(notebookFile('AI inserted content').document)
      )
    )
    notify('change', 'qc.ipynb')
    await applied
    await runtime.flush()
    assert.equal(
      runtime.state.activeAnalysisNotebook?.document.cells[0].source,
      'AI inserted content'
    )
  } finally {
    watcher.dispose()
    runtime.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the read-only refresh IPC registers disk watching without changing the active path or tool draft', async () => {
  const path = 'src/main/ipc/analysis-ipc.ts'
  const syntax = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  let registration: ts.CallExpression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(syntax) === 'options.ipcMain.handle' &&
      node.arguments[0]?.getText(syntax) === 'IPC.analysis.refreshNotebook'
    )
      registration = node
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.ok(registration)
  const code = ts.transpileModule(registration.getText(syntax), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  let handler!: (_event: unknown, cwd: string, path: string) => Promise<AnalysisNotebookFile>
  const activePaths = new Map([['/project', '/project/notebooks/current.ipynb']])
  const file = notebookFile('disk')
  const diskReads: unknown[][] = []
  runInNewContext(code, {
    IPC,
    options: {
      ipcMain: {
        handle: (_channel: string, callback: typeof handler) => {
          handler = callback
        }
      },
      notebooks: {
        resolveWorkspaceByCwd: (cwd: string) =>
          cwd === '/project' ? { workingDirectory: cwd } : null,
        operations: {
          openFile: async (...args: unknown[]) => {
            diskReads.push(args)
            return file
          },
          syncDraft: () => assert.fail('read-only refresh must not replace the tool draft')
        },
        activePathByProjectCwd: activePaths
      }
    }
  })
  assert.equal(await handler(null, '/project', file.relativePath), file)
  assert.deepEqual(diskReads[0], [{ workingDirectory: '/project' }, file.relativePath, true])
  assert.equal(activePaths.get('/project'), '/project/notebooks/current.ipynb')
  await assert.rejects(handler(null, '/missing', file.relativePath), /请选择/)
})
