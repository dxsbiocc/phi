import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import {
  createNotebookAutosave,
  shouldPreserveNotebookDraftOnSave,
  type NotebookAutosave
} from '../src/renderer/src/features/analysis/lib/notebookAutosave'
import type { AnalysisNotebookFile } from '../src/renderer/src/types'
import { parseNotebook, updateNotebookCell } from '../src/shared/notebookDocument'
import {
  acceptStagedNotebookCell,
  type NotebookAiPromptDraft
} from '../src/renderer/src/features/analysis/lib/notebookAiPromptDraft'

function fixture(path = '/project/test.ipynb'): AnalysisNotebookFile {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: 'one',
        cell_type: 'code',
        source: '1',
        metadata: {},
        execution_count: null,
        outputs: []
      }
    ]
  })
  return {
    path,
    relativePath: path.split('/').at(-1)!,
    name: 'test.ipynb',
    bytes: 0,
    modifiedAt: '',
    contentHash: 'original-hash',
    savedRevision: document.revision,
    document
  }
}

type SaveCall = { file: AnalysisNotebookFile; document: AnalysisNotebookFile['document'] }
function harness(
  save?: (
    file: AnalysisNotebookFile,
    document: AnalysisNotebookFile['document']
  ) => Promise<AnalysisNotebookFile | false>
): {
  coordinator: NotebookAutosave
  calls: SaveCall[]
  timers: Map<number, () => void>
  runTimers: () => Promise<void>
} {
  const timers = new Map<number, () => void>()
  let timerId = 0
  const calls: { file: AnalysisNotebookFile; document: AnalysisNotebookFile['document'] }[] = []
  const coordinator = createNotebookAutosave({
    save: async (file, document) => {
      calls.push({ file, document })
      return save
        ? save(file, document)
        : {
            ...file,
            document,
            savedRevision: document.revision,
            contentHash: `hash-${document.revision}`
          }
    },
    setTimer: (callback) => {
      timers.set(++timerId, callback)
      return timerId
    },
    clearTimer: (id) => {
      timers.delete(id as number)
    }
  })
  const runTimers = async (): Promise<void> => {
    const pending = [...timers.values()]
    timers.clear()
    pending.forEach((callback) => callback())
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return { coordinator, calls, timers, runTimers }
}

test('autosave debounces latest edits and does not write an unchanged notebook', async () => {
  const file = fixture()
  const { coordinator, calls, timers, runTimers } = harness()
  coordinator.observe(file, file.document)
  assert.equal(timers.size, 0)
  coordinator.observe(file, updateNotebookCell(file.document, 'one', { source: '2' }))
  const latest = updateNotebookCell(file.document, 'one', { source: '3' })
  coordinator.observe(file, latest)
  assert.equal(timers.size, 1)
  assert.equal(coordinator.state(file.path), 'pending')
  await runTimers()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].document.revision, latest.revision)
  assert.equal(coordinator.state(file.path), 'saved')
})

test('autosave serializes in-flight edits and advances revision/hash for the next write', async () => {
  let finish: ((saved: AnalysisNotebookFile) => void) | undefined
  const file = fixture()
  const { coordinator, calls, runTimers } = harness((candidate, document) =>
    calls.length === 1
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve({ ...candidate, document, savedRevision: document.revision })
  )
  const first = updateNotebookCell(file.document, 'one', { source: '2' })
  coordinator.observe(file, first)
  await runTimers()
  const latest = updateNotebookCell(first, 'one', { source: '3' })
  coordinator.observe(file, latest)
  await runTimers()
  assert.equal(calls.length, 1)
  finish!({ ...file, document: first, savedRevision: first.revision, contentHash: 'first-hash' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 2)
  assert.equal(calls[1].file.savedRevision, first.revision)
  assert.equal(calls[1].file.contentHash, 'first-hash')
  assert.equal(calls[1].document.revision, latest.revision)
  assert.equal(coordinator.state(file.path), 'saved')
})

test('flush on switching keeps file paths separate', async () => {
  const first = fixture()
  const second = fixture('/project/other.ipynb')
  const { coordinator, calls, runTimers } = harness()
  coordinator.observe(first, updateNotebookCell(first.document, 'one', { source: 'first' }))
  coordinator.flush(first.path)
  coordinator.observe(second, updateNotebookCell(second.document, 'one', { source: 'second' }))
  await runTimers()
  assert.deepEqual(
    calls.map((call) => call.file.path),
    [first.path, second.path]
  )
})

test('a conflicting save preserves the draft and pauses automatic retries until manual retry', async () => {
  let rejectSave = true
  const { coordinator, calls, runTimers } = harness(async (file, document) =>
    rejectSave ? false : { ...file, document, savedRevision: document.revision }
  )
  const file = fixture()
  const edited = updateNotebookCell(file.document, 'one', { source: '2' })
  coordinator.observe(file, edited)
  await runTimers()
  assert.equal(coordinator.state(file.path), 'error')
  const newer = updateNotebookCell(edited, 'one', { source: '3' })
  coordinator.observe(file, newer)
  await runTimers()
  assert.equal(calls.length, 1)
  rejectSave = false
  assert.equal(await coordinator.saveNow(file, newer), true)
  assert.equal(calls[1].document.revision, newer.revision)
})

test('manual acceptance joins automatic writes without a duplicate save', async () => {
  const file = fixture()
  const { coordinator, calls, runTimers } = harness()
  const accepted = updateNotebookCell(file.document, 'one', { source: 'accepted AI code' })
  coordinator.observe(file, accepted)
  assert.equal(await coordinator.saveNow(file, accepted), true)
  coordinator.observe(file, accepted)
  await runTimers()
  assert.equal(calls.length, 1)
})

test('a stale parent file acknowledgement cannot restore an earlier baseline hash', async () => {
  const file = fixture()
  const { coordinator, calls, runTimers } = harness()
  const first = updateNotebookCell(file.document, 'one', { source: '2' })
  coordinator.observe(file, first)
  await runTimers()
  const newer = updateNotebookCell(first, 'one', { source: '3' })
  coordinator.observe(file, newer)
  await runTimers()
  assert.equal(calls[1].file.savedRevision, first.revision)
  assert.equal(calls[1].file.contentHash, `hash-${first.revision}`)
})

test('save acknowledgement keeps newer local edits but real external updates remain adoptable', () => {
  const file = fixture()
  const first = updateNotebookCell(file.document, 'one', { source: '2' })
  const latest = updateNotebookCell(first, 'one', { source: '3' })
  assert.equal(shouldPreserveNotebookDraftOnSave(latest, first, true), true)
  assert.equal(shouldPreserveNotebookDraftOnSave(latest, first, false), false)
  assert.equal(shouldPreserveNotebookDraftOnSave(null, first, true), false)
})

test('the real Canvas acceptance callback applies immediately and never restores its pre-save snapshot', async () => {
  const file = fixture()
  let document = file.document
  let draft: NotebookAiPromptDraft | null = {
    id: 'generation',
    mode: 'insert',
    afterCellId: 'one',
    targetCellId: null,
    prompt: 'add a cell',
    language: 'python',
    model: null,
    references: [],
    isGenerating: false,
    error: null,
    errorDetail: null,
    stagedCells: [
      { previewId: 'preview', afterCellId: 'one', cellType: 'code', source: 'print(2)' }
    ]
  }
  let finishSave: (() => void) | undefined
  const save = new Promise<boolean>((resolve) => {
    finishSave = () => resolve(true)
  })
  const source = ts.createSourceFile(
    'NotebookCanvas.tsx',
    readFileSync('src/renderer/src/features/analysis/notebook/NotebookCanvas.tsx', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let expression: ts.Expression | undefined
  const findAcceptance = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'acceptAiPreviewCell') {
      expression = node.initializer
    }
    ts.forEachChild(node, findAcceptance)
  }
  findAcceptance(source)
  assert.ok(expression)
  const code = ts.transpileModule(`(${expression.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const accept = runInNewContext(code, {
    useCallback: (callback: unknown) => callback,
    aiPromptDraft: draft,
    draftDocument: document,
    acceptStagedNotebookCell,
    saveNotebookDocument: () => save,
    setDraftDocument: (next: typeof document) => {
      document = next
    },
    setAiPromptDraft: (update: (current: typeof draft) => typeof draft) => {
      draft = update(draft)
    }
  }) as (id: string) => Promise<void>
  const completion = accept('preview')
  assert.equal(document.cells.length, 2)
  assert.equal(draft, null)
  document = updateNotebookCell(document, 'one', { source: 'typed during slow save' })
  finishSave!()
  await completion
  assert.equal(document.cells[0].source, 'typed during slow save')
})

test('observing identical props does not continuously notify React subscribers', () => {
  const file = fixture()
  const { coordinator } = harness()
  let notifications = 0
  coordinator.subscribe(() => {
    notifications += 1
  })
  coordinator.observe(file, file.document)
  coordinator.observe({ ...file }, file.document)
  assert.equal(notifications, 1)
})

test('a clean external revert to previously saved content is not mistaken for a local save acknowledgement', async () => {
  const file = fixture()
  const { coordinator, calls, runTimers } = harness()
  const first = updateNotebookCell(file.document, 'one', { source: '2' })
  coordinator.observe(file, first)
  await runTimers()
  const latest = updateNotebookCell(first, 'one', { source: '3' })
  coordinator.observe(file, latest)
  await runTimers()
  assert.equal(coordinator.isLocalSaveRevision(file.path, first.revision), false)
  assert.equal(
    coordinator.isLocalSaveRevision(file.path, latest.revision, `hash-${latest.revision}`),
    true
  )
  assert.equal(coordinator.isLocalSaveRevision(file.path, latest.revision, 'external-hash'), false)
  coordinator.observe(
    { ...file, document: first, savedRevision: first.revision, contentHash: 'external-hash' },
    first
  )
  await runTimers()
  assert.equal(coordinator.state(file.path), 'saved')
  assert.equal(calls.length, 2)
})

test('an external formatting-only write advances the hash for the next edit', async () => {
  const file = fixture()
  const { coordinator, calls, runTimers } = harness()
  coordinator.observe(file, file.document)
  const reformatted = { ...file, contentHash: 'externally-reformatted' }
  coordinator.observe(reformatted, reformatted.document)
  coordinator.observe(reformatted, updateNotebookCell(file.document, 'one', { source: '2' }))
  await runTimers()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file.contentHash, 'externally-reformatted')
})

test('a changed external baseline cannot silently authorize overwriting a pending local draft', async () => {
  const file = fixture()
  const { coordinator, calls, runTimers } = harness()
  const local = updateNotebookCell(file.document, 'one', { source: 'local draft' })
  const external = updateNotebookCell(file.document, 'one', { source: 'external change' })
  coordinator.observe(file, local)
  coordinator.observe(
    { ...file, document: external, savedRevision: external.revision, contentHash: 'external-hash' },
    local
  )
  await runTimers()
  assert.equal(calls[0].document.revision, local.revision)
  assert.equal(calls[0].file.savedRevision, file.savedRevision)
  assert.equal(calls[0].file.contentHash, file.contentHash)
})

test('an external baseline observed before Canvas adopts its document never becomes a local acknowledgement', async () => {
  const file = fixture()
  const { coordinator, calls, runTimers } = harness()
  const first = updateNotebookCell(file.document, 'one', { source: '2' })
  coordinator.observe(file, first)
  await runTimers()
  const latest = updateNotebookCell(first, 'one', { source: '3' })
  coordinator.observe(file, latest)
  await runTimers()
  const external = {
    ...file,
    document: first,
    savedRevision: first.revision,
    contentHash: 'external-revert'
  }
  // Layout sees the new file before the passive Canvas adoption runs.
  coordinator.observe(external, latest)
  assert.equal(
    coordinator.isLocalSaveRevision(file.path, first.revision, external.contentHash),
    false
  )
  coordinator.observe(external, first)
  await runTimers()
  assert.equal(coordinator.state(file.path), 'saved')
  assert.equal(calls.length, 2)
  assert.equal(
    coordinator.isLocalSaveRevision(file.path, latest.revision, `hash-${latest.revision}`),
    false,
    'a settled external refresh retires the old acknowledgement'
  )
})

test('the real AnalysisView key isolates identical remote notebook paths across projects and stays stable while editing', () => {
  const source = ts.createSourceFile(
    'App.tsx',
    readFileSync('src/renderer/src/App.tsx', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let keyExpression: ts.Expression | undefined
  const findViewKey = (node: ts.Node): void => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(source) === 'AnalysisView'
    ) {
      const key = node.attributes.properties.find(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'key'
      )
      if (key && ts.isJsxAttribute(key) && key.initializer && ts.isJsxExpression(key.initializer))
        keyExpression = key.initializer.expression
    }
    ts.forEachChild(node, findViewKey)
  }
  findViewKey(source)
  const viewKeyExpression = keyExpression
  assert.ok(viewKeyExpression, 'AnalysisView must remount its save queue at the workspace boundary')
  const key = (projectId: string | null, cwd: string, text: string): unknown =>
    runInNewContext(`(${viewKeyExpression.getText(source)})`, {
      activeProject: projectId ? { id: projectId } : null,
      activeCwd: cwd,
      activeAnalysisNotebook: { path: '/shared/notebooks/same.ipynb', document: { source: text } }
    })
  assert.notEqual(key('remote-host-a', '/shared', '1'), key('remote-host-b', '/shared', '1'))
  assert.equal(key('remote-host-a', '/shared', '1'), key('remote-host-a', '/shared', 'edited'))
  assert.notEqual(key(null, '/ordinary-a', '1'), key(null, '/ordinary-b', '1'))
})
