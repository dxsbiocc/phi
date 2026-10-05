import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { test } from 'node:test'

import {
  assertOfficeWatchCleanupResult,
  isOwnedLoopbackListener,
  OfficePreviewProcessManager,
  OfficeWatchError,
  previewHtmlHasSheetTab
} from '../src/main/agent/office/office-watch'

test('gateway startup cleanup retains a partial watch for retry', async () => {
  let stopAttempts = 0
  const artifact = {
    artifactId: 'blank-1',
    sessionId: 'session-1',
    projectId: null,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: '/sessions/session-1/artifacts/office/blank-1/blank.xlsx'
  }
  const manager = new OfficePreviewProcessManager({
    availablePort: async () => 31_001,
    startWatch: async (binaryPath, inputArtifact, port) => ({
      artifact: inputArtifact,
      binaryPath,
      pid: 202,
      port,
      stop: async () => {
        stopAttempts += 1
        if (stopAttempts === 1) throw new OfficeWatchError('unwatch-failed', '停止失败')
      }
    }),
    startGateway: async () => {
      throw new Error('gateway failed')
    }
  })

  await assert.rejects(manager.start('/officecli', artifact), /停止失败/)
  assert.equal(stopAttempts, 1)

  await manager.stop(artifact)
  assert.equal(stopAttempts, 2)
})

test('unwatch failures stay explicit so ownership can be retried', () => {
  assert.throws(
    () =>
      assertOfficeWatchCleanupResult({
        exitCode: 1,
        stdout: '',
        stderr: 'resident busy',
        timedOut: false,
        truncated: false
      }),
    (error: unknown) => error instanceof OfficeWatchError && error.code === 'unwatch-failed'
  )
})

test('readiness rejects a loopback port owned by a competing process', async () => {
  const competitor = createServer()
  await new Promise<void>((resolve, reject) => {
    competitor.once('error', reject)
    competitor.listen(0, '127.0.0.1', () => resolve())
  })
  try {
    const address = competitor.address()
    if (!address || typeof address === 'string') throw new Error('missing competitor port')
    assert.equal(await isOwnedLoopbackListener(process.pid, address.port), true)
    assert.equal(await isOwnedLoopbackListener(process.pid + 1, address.port), false)
  } finally {
    await new Promise<void>((resolve) => competitor.close(() => resolve()))
  }
})

test('watch selections stay bound to their artifact and stop after cleanup', async () => {
  const selections: unknown[] = []
  let publish: ((selection: unknown) => void) | undefined
  const artifact = {
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: null,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: '/sessions/session-1/artifacts/office/artifact-1/blank.xlsx'
  }
  const manager = new OfficePreviewProcessManager(
    {
      availablePort: async () => 31_001,
      startWatch: async (binaryPath, inputArtifact, port) => ({
        artifact: inputArtifact,
        binaryPath,
        pid: 202,
        port,
        stop: async () => undefined
      }),
      startGateway: async (input) => {
        publish = input.onSelection as (selection: unknown) => void
        return {
          artifactId: input.artifactId,
          port: 42_001,
          url: 'http://127.0.0.1:42001/',
          close: async () => undefined
        }
      }
    },
    (artifactId, selection) => selections.push({ artifactId, selection })
  )

  await manager.start('/officecli', artifact)
  publish?.({ sheet: 'Sheet1', range: 'A1', paths: ['/Sheet1/A1'] })
  await manager.stop(artifact)
  publish?.({ sheet: 'Sheet1', range: 'B2', paths: ['/Sheet1/B2'] })

  assert.deepEqual(selections, [
    {
      artifactId: 'artifact-1',
      selection: { sheet: 'Sheet1', range: 'A1', paths: ['/Sheet1/A1'] }
    }
  ])
})

test('confirmed writes publish only to their artifact with visible follow preferences', async () => {
  const publications = new Map<
    string,
    Array<{ target: { sheet: string; range?: string }; follow: boolean }>
  >()
  const artifacts = ['artifact-follow-a', 'artifact-follow-b'].map((artifactId, index) => ({
    artifactId,
    sessionId: `session-${index + 1}`,
    projectId: null,
    kind: 'xlsx' as const,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: `/sessions/session-${index + 1}/artifacts/office/${artifactId}/blank.xlsx`
  }))
  let nextPort = 31_020
  const manager = new OfficePreviewProcessManager({
    availablePort: async () => nextPort++,
    startWatch: async (binaryPath, artifact, port) => ({
      artifact,
      binaryPath,
      pid: port,
      port,
      stop: async () => undefined
    }),
    startGateway: async (input) => ({
      artifactId: input.artifactId,
      port: input.upstreamPort + 10_000,
      url: `http://127.0.0.1:${input.upstreamPort + 10_000}/`,
      publishHighlight: (target: { sheet: string; range?: string }, follow: boolean) => {
        const entries = publications.get(input.artifactId) ?? []
        entries.push({ target, follow })
        publications.set(input.artifactId, entries)
        return true
      },
      close: async () => undefined
    })
  })
  await manager.start('/officecli', artifacts[0]!)
  await manager.start('/officecli', artifacts[1]!)

  manager.setPreviewPreferences('artifact-follow-a', { visible: true, followAi: true })
  manager.setPreviewPreferences('artifact-follow-b', { visible: true, followAi: false })
  manager.publishConfirmedWrite('artifact-follow-a', {
    type: 'set_range',
    sheet: 'Sheet1',
    range: 'A1:B3',
    values: [
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f']
    ],
    rowCount: 3,
    columnCount: 2,
    cellCount: 6
  })
  manager.publishConfirmedWrite('artifact-follow-a', {
    type: 'add_sheet',
    name: '汇总表'
  })
  manager.publishConfirmedWrite('artifact-follow-b', {
    type: 'set_cell',
    sheet: 'Sheet2',
    cell: 'C4',
    value: 'updated'
  })
  manager.publishConfirmedWrite('missing-artifact', {
    type: 'set_cell',
    sheet: 'Sheet1',
    cell: 'Z9',
    value: 'missing'
  })

  assert.deepEqual(publications.get('artifact-follow-a'), [
    { target: { sheet: 'Sheet1', range: 'A1:B3' }, follow: true },
    { target: { sheet: '汇总表' }, follow: true }
  ])
  assert.deepEqual(publications.get('artifact-follow-b'), [
    { target: { sheet: 'Sheet2', range: 'C4' }, follow: false }
  ])
  assert.equal(publications.has('missing-artifact'), false)

  await manager.stop(artifacts[0]!)
  await manager.stop(artifacts[1]!)
})

test('an invisible preview receives a marker without a follow instruction', async () => {
  const publications: Array<{ target: unknown; follow: boolean }> = []
  const artifact = {
    artifactId: 'artifact-background',
    sessionId: 'session-background',
    projectId: null,
    kind: 'xlsx' as const,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: '/sessions/session-background/artifacts/office/artifact-background/blank.xlsx'
  }
  const manager = new OfficePreviewProcessManager({
    availablePort: async () => 31_030,
    startWatch: async (binaryPath, inputArtifact, port) => ({
      artifact: inputArtifact,
      binaryPath,
      pid: 230,
      port,
      stop: async () => undefined
    }),
    startGateway: async (input) => ({
      artifactId: input.artifactId,
      port: 42_030,
      url: 'http://127.0.0.1:42030/',
      publishHighlight: (target: { sheet: string; range?: string }, follow: boolean) => {
        publications.push({ target, follow })
        return true
      },
      close: async () => undefined
    })
  })
  await manager.start('/officecli', artifact)
  manager.setPreviewPreferences(artifact.artifactId, { visible: false, followAi: true })

  manager.publishConfirmedWrite(artifact.artifactId, {
    type: 'set_cell',
    sheet: 'Sheet1',
    cell: 'J1000',
    value: 'background'
  })

  assert.deepEqual(publications, [{ target: { sheet: 'Sheet1', range: 'J1000' }, follow: false }])
  await manager.stop(artifact)
})

test('non-XLSX previews never publish spreadsheet highlights', async () => {
  for (const kind of ['docx', 'pptx'] as const) {
    let publications = 0
    const artifact = {
      artifactId: `artifact-${kind}-highlight`,
      sessionId: `session-${kind}`,
      projectId: null,
      kind,
      origin: 'blank' as const,
      sourcePath: null,
      sourceHash: null,
      draftPath: `/sessions/session-${kind}/artifacts/office/artifact-${kind}/blank.${kind}`
    }
    const manager = new OfficePreviewProcessManager({
      availablePort: async () => (kind === 'docx' ? 31_040 : 31_041),
      startWatch: async (binaryPath, inputArtifact, port) => ({
        artifact: inputArtifact,
        binaryPath,
        pid: port,
        port,
        stop: async () => undefined
      }),
      startGateway: async (input) => ({
        artifactId: input.artifactId,
        port: input.upstreamPort + 10_000,
        url: `http://127.0.0.1:${input.upstreamPort + 10_000}/`,
        publishHighlight: () => {
          publications += 1
          return true
        },
        close: async () => undefined
      }),
      inspectDocxPreview: async () => [],
      inspectPptxPreview: async () => 0,
      loadPreviewHtml: async () =>
        kind === 'docx'
          ? '<div class="page-wrapper"><div class="page"><div class="page-body"></div></div></div>'
          : '<html><body><div class="main"></div><div class="thumbnails"></div><div class="page-counter">0 / 0</div></body></html>'
    })
    await manager.start('/officecli', artifact)
    manager.setPreviewPreferences(artifact.artifactId, { visible: true, followAi: true })

    manager.publishConfirmedWrite(artifact.artifactId, {
      type: 'set_cell',
      sheet: 'Sheet1',
      cell: 'A1',
      value: 'ignored'
    })

    assert.equal(publications, 0)
    await manager.stop(artifact)
  }
})

test('DOCX watch establishes a self-checked HTML baseline and reports preview health', async () => {
  let publishFull: ((version: number) => void) | undefined
  let docxHumanEdit: unknown
  let html =
    '<div class="page-wrapper"><div class="page"><div class="page-body">中文段落 &amp; &lt;Phi&gt;</div></div></div>'
  const artifact = {
    artifactId: 'artifact-docx',
    sessionId: 'session-1',
    projectId: null,
    kind: 'docx' as const,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: '/sessions/session-1/artifacts/office/artifact-docx/blank.docx'
  }
  const manager = new OfficePreviewProcessManager(
    {
      availablePort: async () => 31_010,
      startWatch: async (binaryPath, inputArtifact, port) => ({
        artifact: inputArtifact,
        binaryPath,
        pid: 210,
        port,
        stop: async () => undefined
      }),
      startGateway: async (input) => {
        publishFull = input.onFullRefresh
        docxHumanEdit = input.onHumanCellEdit
        return {
          artifactId: input.artifactId,
          port: 42_010,
          url: 'http://127.0.0.1:42010/',
          close: async () => undefined
        }
      },
      inspectDocxPreview: async () => ['中文段落 & <Phi>'],
      loadPreviewHtml: async () => html
    },
    () => undefined,
    { apply: async () => undefined, access: () => 'writable', rejected: () => undefined }
  )

  const ownership = await manager.start('/officecli', artifact)

  assert.equal(ownership.previewState, 'ready')
  assert.equal(ownership.previewError, undefined)
  assert.equal(docxHumanEdit, undefined)
  const confirmation = manager.armDocumentTextConfirmation('artifact-docx', '新增中文')
  confirmation.markDispatched?.()
  html = html.replace('</div></div></div>', '<p>新增中文</p></div></div></div>')
  publishFull?.(1)
  assert.equal(await confirmation.promise, true)
  await manager.stop(artifact)
})

test('DOCX render self-check failure keeps the watch owned and exposes preview_failed', async () => {
  let stopped = 0
  const artifact = {
    artifactId: 'artifact-docx-failed',
    sessionId: 'session-1',
    projectId: null,
    kind: 'docx' as const,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: '/sessions/session-1/artifacts/office/artifact-docx-failed/blank.docx'
  }
  const manager = new OfficePreviewProcessManager({
    availablePort: async () => 31_011,
    startWatch: async (binaryPath, inputArtifact, port) => ({
      artifact: inputArtifact,
      binaryPath,
      pid: 211,
      port,
      stop: async () => {
        stopped += 1
      }
    }),
    startGateway: async (input) => ({
      artifactId: input.artifactId,
      port: 42_011,
      url: 'http://127.0.0.1:42011/',
      close: async () => undefined
    }),
    inspectDocxPreview: async () => ['应出现的正文'],
    loadPreviewHtml: async () => '<html><body>render failed</body></html>'
  })

  const ownership = await manager.start('/officecli', artifact)

  assert.equal(ownership.previewState, 'preview_failed')
  assert.match(ownership.previewError ?? '', /预览渲染失败/)
  assert.equal(stopped, 0)
  await manager.stop(artifact)
  assert.equal(stopped, 1)
})

test('PPTX watch self-check exposes an authoritative zero slide count without human editing', async () => {
  let pptxHumanEdit: unknown
  let publishPresentationChange: ((version: number, slideCountChanged: boolean) => void) | undefined
  let inspections = 0
  const slideCounts: number[] = []
  let resolveOlder!: (value: number) => void
  let resolveNewer!: (value: number) => void
  const older = new Promise<number>((resolve) => {
    resolveOlder = resolve
  })
  const newer = new Promise<number>((resolve) => {
    resolveNewer = resolve
  })
  const artifact = {
    artifactId: 'artifact-pptx',
    sessionId: 'session-1',
    projectId: null,
    kind: 'pptx' as const,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: '/sessions/session-1/artifacts/office/artifact-pptx/blank.pptx'
  }
  const manager = new OfficePreviewProcessManager(
    {
      availablePort: async () => 31_012,
      startWatch: async (binaryPath, inputArtifact, port) => ({
        artifact: inputArtifact,
        binaryPath,
        pid: 212,
        port,
        stop: async () => undefined
      }),
      startGateway: async (input) => {
        pptxHumanEdit = input.onHumanCellEdit
        publishPresentationChange = input.onPresentationChange
        return {
          artifactId: input.artifactId,
          port: 42_012,
          url: 'http://127.0.0.1:42012/',
          close: async () => undefined
        }
      },
      inspectPptxPreview: async () => {
        inspections += 1
        if (inspections === 1) return 0
        return inspections === 2 ? older : newer
      },
      loadPreviewHtml: async () =>
        '<html><body><div class="main"></div><div class="page-counter">1 / 0</div></body></html>'
    },
    () => undefined,
    { apply: async () => undefined, access: () => 'writable', rejected: () => undefined },
    (_artifactId, slideCount) => slideCounts.push(slideCount)
  )

  const ownership = await manager.start('/officecli', artifact)

  assert.deepEqual(
    {
      previewState: ownership.previewState,
      previewError: ownership.previewError,
      slideCount: ownership.slideCount,
      pptxHumanEdit
    },
    { previewState: 'ready', previewError: undefined, slideCount: 0, pptxHumanEdit: undefined }
  )
  publishPresentationChange?.(1, true)
  publishPresentationChange?.(2, true)
  resolveNewer(2)
  await new Promise((resolve) => setImmediate(resolve))
  resolveOlder(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(slideCounts, [2])
  await manager.stop(artifact)
})

test('PPTX text confirmation uses add/replace versions and times out without matching HTML', async () => {
  let publishPresentationChange: ((version: number, slideCountChanged: boolean) => void) | undefined
  let html =
    '<html><body><div class="main"></div><div class="page-counter">1 / 0</div></body></html>'
  const artifact = {
    artifactId: 'artifact-pptx-confirm',
    sessionId: 'session-1',
    projectId: null,
    kind: 'pptx' as const,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: '/sessions/session-1/artifacts/office/artifact-pptx-confirm/blank.pptx'
  }
  const manager = new OfficePreviewProcessManager({
    availablePort: async () => 31_014,
    startWatch: async (binaryPath, inputArtifact, port) => ({
      artifact: inputArtifact,
      binaryPath,
      pid: 214,
      port,
      stop: async () => undefined
    }),
    startGateway: async (input) => {
      publishPresentationChange = input.onPresentationChange
      return {
        artifactId: input.artifactId,
        port: 42_014,
        url: 'http://127.0.0.1:42014/',
        close: async () => undefined
      }
    },
    inspectPptxPreview: async () => (html.includes('slide-container') ? 1 : 0),
    loadPreviewHtml: async () => html,
    previewConfirmationTimeoutMs: 20
  })
  await manager.start('/officecli', artifact)

  const added = manager.armDocumentTextConfirmation(artifact.artifactId, '标题 & < >')
  added.markDispatched?.()
  html =
    '<html><body><div class="main"><div class="slide-container">标题 &amp; &lt; &gt;</div></div><div class="thumb"></div><div class="page-counter">1 / 1</div></body></html>'
  publishPresentationChange?.(1, true)
  assert.equal(await added.promise, true)

  const missing = manager.armDocumentTextConfirmation(artifact.artifactId, '不存在')
  missing.markDispatched?.()
  publishPresentationChange?.(2, false)
  assert.equal(await missing.promise, false)
  await manager.stop(artifact)
})

test('PPTX slide-count mismatch keeps the watch owned and exposes preview_failed', async () => {
  let stopped = 0
  const artifact = {
    artifactId: 'artifact-pptx-failed',
    sessionId: 'session-1',
    projectId: null,
    kind: 'pptx' as const,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: '/sessions/session-1/artifacts/office/artifact-pptx-failed/blank.pptx'
  }
  const manager = new OfficePreviewProcessManager({
    availablePort: async () => 31_013,
    startWatch: async (binaryPath, inputArtifact, port) => ({
      artifact: inputArtifact,
      binaryPath,
      pid: 213,
      port,
      stop: async () => {
        stopped += 1
      }
    }),
    startGateway: async (input) => ({
      artifactId: input.artifactId,
      port: 42_013,
      url: 'http://127.0.0.1:42013/',
      close: async () => undefined
    }),
    inspectPptxPreview: async () => 2,
    loadPreviewHtml: async () =>
      '<html><body><div class="main"><div class="slide-container"></div></div><div class="thumb"></div><div class="page-counter">1 / 1</div></body></html>'
  })

  const ownership = await manager.start('/officecli', artifact)

  assert.equal(ownership.previewState, 'preview_failed')
  assert.equal(ownership.slideCount, 2)
  assert.match(ownership.previewError ?? '', /幻灯片数量与文档不一致/u)
  assert.equal(stopped, 0)
  await manager.stop(artifact)
  assert.equal(stopped, 1)
})

test('cell patch confirmation is armed before a write and times out without a match', async () => {
  let publishPatch: ((patch: { sheet: string; cell: string }) => void) | undefined
  const artifact = {
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: null,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: '/sessions/session-1/artifacts/office/artifact-1/blank.xlsx'
  }
  const manager = new OfficePreviewProcessManager({
    availablePort: async () => 31_001,
    startWatch: async (binaryPath, inputArtifact, port) => ({
      artifact: inputArtifact,
      binaryPath,
      pid: 202,
      port,
      stop: async () => undefined
    }),
    startGateway: async (input) => {
      publishPatch = input.onCellPatch
      return {
        artifactId: input.artifactId,
        port: 42_001,
        url: 'http://127.0.0.1:42001/',
        close: async () => undefined
      }
    },
    previewConfirmationTimeoutMs: 10
  })
  await manager.start('/officecli', artifact)

  const matching = manager.armCellPatchConfirmation('artifact-1', 'Sheet1', 'A1')
  matching.markDispatched?.()
  publishPatch?.({ sheet: 'Sheet1', cell: 'A1' })
  assert.equal(await matching.promise, true)

  const missing = manager.armCellPatchConfirmation('artifact-1', 'Sheet1', 'B2')
  missing.markDispatched?.()
  assert.equal(await missing.promise, false)
  await manager.stop(artifact)
})

test('range patch confirmation waits for every affected cell across patch events', async () => {
  let publishPatch: ((patch: { sheet: string; cell: string }) => void) | undefined
  const artifact = {
    artifactId: 'artifact-range',
    sessionId: 'session-1',
    projectId: null,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: '/sessions/session-1/artifacts/office/artifact-range/blank.xlsx'
  }
  const manager = new OfficePreviewProcessManager({
    availablePort: async () => 31_002,
    startWatch: async (binaryPath, inputArtifact, port) => ({
      artifact: inputArtifact,
      binaryPath,
      pid: 203,
      port,
      stop: async () => undefined
    }),
    startGateway: async (input) => {
      publishPatch = input.onCellPatch
      return {
        artifactId: input.artifactId,
        port: 42_002,
        url: 'http://127.0.0.1:42002/',
        close: async () => undefined
      }
    },
    previewConfirmationTimeoutMs: 50
  })
  await manager.start('/officecli', artifact)

  const confirmation = manager.armCellPatchSetConfirmation('artifact-range', 'Sheet1', [
    'A1',
    'B1',
    'A2',
    'B2'
  ])
  confirmation.markDispatched?.()
  let settled = false
  confirmation.promise.then(() => {
    settled = true
  })
  publishPatch?.({ sheet: 'Other', cell: 'A1' })
  publishPatch?.({ sheet: 'Sheet1', cell: 'A1' })
  publishPatch?.({ sheet: 'Sheet1', cell: 'B1' })
  await Promise.resolve()
  assert.equal(settled, false)
  publishPatch?.({ sheet: 'Sheet1', cell: 'A2' })
  publishPatch?.({ sheet: 'Sheet1', cell: 'B2' })

  assert.equal(await confirmation.promise, true)
  await manager.stop(artifact)
})

test('a post-write full refresh confirms every pending range cell', async () => {
  let publishFull: ((version: number) => void) | undefined
  const artifact = {
    artifactId: 'artifact-full',
    sessionId: 'session-1',
    projectId: null,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: '/sessions/session-1/artifacts/office/artifact-full/blank.xlsx'
  }
  const manager = new OfficePreviewProcessManager({
    availablePort: async () => 31_003,
    startWatch: async (binaryPath, inputArtifact, port) => ({
      artifact: inputArtifact,
      binaryPath,
      pid: 204,
      port,
      stop: async () => undefined
    }),
    startGateway: async (input) => {
      publishFull = input.onFullRefresh
      return {
        artifactId: input.artifactId,
        port: 42_003,
        url: 'http://127.0.0.1:42003/',
        close: async () => undefined
      }
    },
    previewConfirmationTimeoutMs: 10
  })
  await manager.start('/officecli', artifact)
  const initial = manager.armCellPatchSetConfirmation('artifact-full', 'Sheet1', ['A1'])
  initial.markDispatched?.()
  publishFull?.(1)
  assert.equal(await initial.promise, false)
  const confirmation = manager.armCellPatchSetConfirmation('artifact-full', 'Sheet1', ['A1', 'B1'])

  confirmation.markDispatched?.()
  publishFull?.(2)

  assert.equal(await confirmation.promise, true)
  await manager.stop(artifact)
})

test('sheet confirmation requires a baseline, a post-dispatch full refresh, and the exact tab', async () => {
  let publishFull: ((version: number) => void) | undefined
  let html = '<div class="sheet-tab active" data-sheet="0" role="tab">Sheet1</div>'
  const artifact = {
    artifactId: 'artifact-sheet',
    sessionId: 'session-1',
    projectId: null,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: '/sessions/session-1/artifacts/office/artifact-sheet/blank.xlsx'
  }
  const manager = new OfficePreviewProcessManager({
    availablePort: async () => 31_004,
    startWatch: async (binaryPath, inputArtifact, port) => ({
      artifact: inputArtifact,
      binaryPath,
      pid: 205,
      port,
      stop: async () => undefined
    }),
    startGateway: async (input) => {
      publishFull = input.onFullRefresh
      return {
        artifactId: input.artifactId,
        port: 42_004,
        url: 'http://127.0.0.1:42004/',
        close: async () => undefined
      }
    },
    loadPreviewHtml: async () => html,
    previewConfirmationTimeoutMs: 50
  })
  await manager.start('/officecli', artifact)
  publishFull?.(1)
  const confirmation = manager.armSheetConfirmation('artifact-sheet', '汇总 & 表')
  publishFull?.(2)
  confirmation.markDispatched?.()
  publishFull?.(2)
  await Promise.resolve()
  html += '<div class="sheet-tab" data-sheet="1" role="tab" tabindex="0">汇总 &amp; 表</div>'
  publishFull?.(3)

  assert.equal(await confirmation.promise, true)
  assert.equal(previewHtmlHasSheetTab(html, '汇总 & 表'), true)
  assert.equal(previewHtmlHasSheetTab(html, '汇总'), false)
  await manager.stop(artifact)
})
