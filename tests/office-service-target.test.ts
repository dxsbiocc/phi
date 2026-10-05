import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OfficeService,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function dependencies(): OfficeServiceDependencies {
  return {
    detectRuntime: async () => ({
      state: 'available',
      binaryPath: '/officecli',
      version: '1.0.153',
      platform: 'darwin-arm64'
    }),
    prepareDraft: async (input) => ({
      artifactId: 'artifact-1',
      sessionId: input.sessionId,
      projectId: input.projectId,
      sourcePath: input.sourcePath,
      sourceHash: 'hash',
      draftPath: '/sessions/session-1/artifacts/office/artifact-1/source.xlsx'
    }),
    prepareBlankDraft: async () => {
      throw new Error('unused')
    },
    startDocument: async () => ({ residentPid: 101 }),
    adoptCreatedDocument: async () => ({ residentPid: 101 }),
    startPreview: async () => ({
      watchPid: 202,
      watchPort: 31_001,
      gatewayPort: 42_001,
      previewUrl: 'http://127.0.0.1:42001/'
    }),
    stopPreview: async () => undefined,
    closeDocument: async () => undefined,
    removeBlankDraft: async () => undefined,
    validateRegisteredDraft: async () => undefined,
    assertNotOfficeArtifactPath: async () => undefined,
    resolveSelection: async () => null,
    clearSelection: async () => undefined,
    readRange: async () => {
      throw new Error('unused')
    }
  }
}

const openRequest = {
  sessionId: 'session-1',
  projectId: 'project-1',
  sourcePath: '/project/source.xlsx',
  projectLocation: { kind: 'local' as const, path: '/project', realPath: '/project' },
  allowRoots: ['/project']
}

test('a ready artifact binds to the host supplied run identity', async () => {
  const service = new OfficeService(dependencies())
  await service.open(openRequest)

  service.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  assert.deepEqual(service.resolveRunTarget('run-1', 'session-1'), {
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
})

test('selection intent resolves the current draft selection before binding the run', async () => {
  const service = new OfficeService({
    ...dependencies(),
    resolveSelection: async (binaryPath, draftPath) => {
      assert.equal(binaryPath, '/officecli')
      assert.equal(draftPath, '/sessions/session-1/artifacts/office/artifact-1/source.xlsx')
      return {
        sheet: 'Sheet1',
        range: 'A1:B3',
        paths: ['/Sheet1/A1', '/Sheet1/B1', '/Sheet1/A2', '/Sheet1/B2', '/Sheet1/A3', '/Sheet1/B3'],
        resolvedAt: '2026-10-04T12:00:00.000Z'
      }
    }
  })
  await service.open(openRequest)

  await service.bindPromptTarget(
    {
      runId: 'run-selection',
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectId: 'project-1'
    },
    true
  )

  assert.equal(service.resolveRunTarget('run-selection').selection?.range, 'A1:B3')
})

test('selection intent with no current selection is rejected without a document-level fallback', async () => {
  const service = new OfficeService(dependencies())
  await service.open(openRequest)

  await assert.rejects(
    service.bindPromptTarget(
      {
        runId: 'run-no-selection',
        artifactId: 'artifact-1',
        sessionId: 'session-1',
        projectId: 'project-1'
      },
      true
    ),
    { code: 'selection_unavailable', message: '无法读取当前选区，请重新选择或清除选区' }
  )
  assert.throws(() => service.resolveRunTarget('run-no-selection'), { code: 'no_target' })
})

test('changing the live selection after binding cannot change the run snapshot', async () => {
  let range = 'A1:B3'
  const service = new OfficeService({
    ...dependencies(),
    resolveSelection: async () => ({
      sheet: 'Sheet1',
      range,
      paths: [`/Sheet1/${range}`],
      resolvedAt: '2026-10-04T12:00:00.000Z'
    })
  })
  await service.open(openRequest)
  await service.bindPromptTarget(
    {
      runId: 'run-stable-selection',
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectId: 'project-1'
    },
    true
  )

  range = 'C1:D3'
  assert.equal(service.resolveRunTarget('run-stable-selection').selection?.range, 'A1:B3')
})

test('closing a document while selection resolution is pending rejects the run binding', async () => {
  let finishResolution!: () => void
  const resolving = new Promise<void>((resolve) => {
    finishResolution = resolve
  })
  const service = new OfficeService({
    ...dependencies(),
    resolveSelection: async () => {
      await resolving
      return {
        sheet: 'Sheet1',
        range: 'A1',
        paths: ['/Sheet1/A1'],
        resolvedAt: '2026-10-04T12:00:00.000Z'
      }
    }
  })
  await service.open(openRequest)
  const binding = service.bindPromptTarget(
    {
      runId: 'run-race',
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectId: 'project-1'
    },
    true
  )
  await service.close('artifact-1', 'session-1')
  finishResolution()

  await assert.rejects(binding, { code: 'target_not_found' })
  assert.throws(() => service.resolveRunTarget('run-race'), { code: 'no_target' })
})

test('preview selection events publish only while the artifact is owned', async () => {
  const service = new OfficeService(dependencies())
  const events: unknown[] = []
  const unsubscribe = service.onSelection((event) => events.push(event))
  await service.open(openRequest)

  service.publishPreviewSelection('artifact-1', {
    sheet: 'Sheet1',
    range: 'A1:B3',
    paths: ['/Sheet1/A1', '/Sheet1/B3']
  })
  await service.close('artifact-1', 'session-1')
  service.publishPreviewSelection('artifact-1', {
    sheet: 'Sheet1',
    range: 'C1',
    paths: ['/Sheet1/C1']
  })
  unsubscribe()

  assert.deepEqual(events, [
    {
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      selection: {
        sheet: 'Sheet1',
        range: 'A1:B3',
        paths: ['/Sheet1/A1', '/Sheet1/B3']
      }
    }
  ])
})

test('clear selection is session-bound and remains document-level when upstream clear fails', async () => {
  const clearedPorts: number[] = []
  const service = new OfficeService({
    ...dependencies(),
    clearSelection: async (watchPort) => {
      clearedPorts.push(watchPort)
      throw new Error('upstream unavailable')
    }
  })
  const events: unknown[] = []
  service.onSelection((event) => events.push(event))
  await service.open(openRequest)

  assert.equal(await service.clearSelection('artifact-1', 'session-2'), false)
  assert.equal(await service.clearSelection('artifact-1', 'session-1'), true)
  assert.deepEqual(clearedPorts, [31_001])
  assert.deepEqual(events, [{ artifactId: 'artifact-1', sessionId: 'session-1', selection: null }])
})

test('preview preferences are session-bound and available only for XLSX', async () => {
  const preferences: unknown[] = []
  const service = new OfficeService({
    ...dependencies(),
    setPreviewPreferences: (artifactId, value) => {
      preferences.push({ artifactId, ...value })
      return true
    }
  })
  await service.open(openRequest)

  assert.equal(
    service.setPreviewPreferences('artifact-1', 'session-2', { visible: true, followAi: true }),
    false
  )
  assert.equal(
    service.setPreviewPreferences('artifact-1', 'session-1', { visible: true, followAi: false }),
    true
  )
  assert.deepEqual(preferences, [{ artifactId: 'artifact-1', visible: true, followAi: false }])

  const docx = new OfficeService({
    ...dependencies(),
    prepareDraft: async (input) => ({
      artifactId: 'artifact-1',
      sessionId: input.sessionId,
      projectId: input.projectId,
      kind: 'docx',
      sourcePath: input.sourcePath,
      sourceHash: 'hash',
      draftPath: '/sessions/session-1/artifacts/office/artifact-1/source.docx'
    }),
    setPreviewPreferences: () => {
      throw new Error('DOCX must not reach XLSX preview preferences')
    }
  })
  await docx.open({ ...openRequest, sourcePath: '/project/source.docx' })
  assert.equal(
    docx.setPreviewPreferences('artifact-1', 'session-1', { visible: true, followAi: true }),
    false
  )
})

test('DOCX never resolves or clears spreadsheet selection upstream', async () => {
  let resolved = 0
  let cleared = 0
  const service = new OfficeService({
    ...dependencies(),
    prepareDraft: async (input) => ({
      artifactId: 'artifact-1',
      sessionId: input.sessionId,
      projectId: input.projectId,
      kind: 'docx',
      sourcePath: input.sourcePath,
      sourceHash: 'hash',
      draftPath: '/sessions/session-1/artifacts/office/artifact-1/source.docx'
    }),
    resolveSelection: async () => {
      resolved += 1
      return null
    },
    clearSelection: async () => {
      cleared += 1
    }
  })
  await service.open({ ...openRequest, sourcePath: '/project/source.docx' })

  await assert.rejects(
    service.bindPromptTarget(
      {
        runId: 'run-docx-selection',
        artifactId: 'artifact-1',
        sessionId: 'session-1',
        projectId: 'project-1'
      },
      true
    ),
    { code: 'selection_unavailable', message: 'Word 文档不支持单元格选区' }
  )
  assert.equal(await service.clearSelection('artifact-1', 'session-1'), true)
  assert.equal(resolved, 0)
  assert.equal(cleared, 0)
})

test('an artifact from another session is rejected without creating a run binding', async () => {
  const service = new OfficeService(dependencies())
  await service.open(openRequest)

  assert.throws(
    () =>
      service.bindRunTarget({
        runId: 'run-foreign',
        artifactId: 'artifact-1',
        sessionId: 'session-2',
        projectId: 'project-2'
      }),
    (error) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'target_session_mismatch' &&
      error.message === '关联的 Office 文档不属于当前会话'
  )
  assert.throws(() => service.resolveRunTarget('run-foreign'), { code: 'no_target' })
})

test('a missing artifact is rejected without falling back to the visible document', async () => {
  const service = new OfficeService(dependencies())
  await service.open(openRequest)

  assert.throws(
    () =>
      service.bindRunTarget({
        runId: 'run-missing',
        artifactId: 'artifact-missing',
        sessionId: 'session-1',
        projectId: 'project-1'
      }),
    { code: 'target_not_found', message: '关联的 Office 文档已不存在或已关闭' }
  )
  assert.throws(() => service.resolveRunTarget('run-missing'), { code: 'no_target' })
})

test('an artifact that is closing is rejected before cleanup finishes', async () => {
  const stopped = deferred()
  const service = new OfficeService({
    ...dependencies(),
    stopPreview: () => stopped.promise
  })
  await service.open(openRequest)

  const closing = service.close('artifact-1', 'session-1')
  assert.throws(
    () =>
      service.bindRunTarget({
        runId: 'run-closing',
        artifactId: 'artifact-1',
        sessionId: 'session-1',
        projectId: 'project-1'
      }),
    { code: 'target_not_found' }
  )

  stopped.resolve()
  await closing
})

test('closing the panel keeps an active run target alive until the run is cleared', async () => {
  const stopped: string[] = []
  const closed: string[] = []
  const service = new OfficeService({
    ...dependencies(),
    stopPreview: async (document) => {
      stopped.push(document.artifactId)
    },
    closeDocument: async (_binaryPath, document) => {
      closed.push(document.artifactId)
    }
  })
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  await service.close('artifact-1', 'session-1')
  assert.deepEqual(service.resolveRunTarget('run-1', 'session-1'), {
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  assert.deepEqual(stopped, [])
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:42001/'), true)

  assert.equal(service.clearRunTarget('run-1'), true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(stopped, ['artifact-1'])
  assert.deepEqual(closed, ['artifact-1'])
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:42001/'), false)
})

test('reopening a run-kept document reuses the same resident, watch, and preview URL', async () => {
  let residentStarts = 0
  let previewStarts = 0
  const service = new OfficeService({
    ...dependencies(),
    startDocument: async () => {
      residentStarts += 1
      return { residentPid: 101 }
    },
    startPreview: async () => {
      previewStarts += 1
      return {
        watchPid: 202,
        watchPort: 31_001,
        gatewayPort: 42_001,
        previewUrl: 'http://127.0.0.1:42001/'
      }
    }
  })
  const opened = await service.open(openRequest)
  assert.equal(opened.state, 'ready')
  service.bindRunTarget({
    runId: 'run-reopen',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  await service.close('artifact-1', 'session-1')
  const reopened = await service.open(openRequest)

  assert.equal(reopened.state, 'ready')
  if (opened.state === 'ready' && reopened.state === 'ready') {
    assert.equal(reopened.document.artifactId, opened.document.artifactId)
    assert.equal(reopened.document.residentPid, opened.document.residentPid)
    assert.equal(reopened.document.watchPid, opened.document.watchPid)
    assert.equal(reopened.document.previewUrl, opened.document.previewUrl)
  }
  assert.equal(residentStarts, 1)
  assert.equal(previewStarts, 1)
})

test('run completion clears its Office target without affecting the document', async () => {
  const service = new OfficeService(dependencies())
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  assert.equal(service.clearRunTarget('run-1'), true)
  assert.throws(() => service.resolveRunTarget('run-1'), { code: 'target_missing' })
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:42001/'), true)
})

test('closing a session clears every Office run target owned by that session', async () => {
  const service = new OfficeService(dependencies())
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  await service.closeSession('session-1')

  assert.throws(() => service.resolveRunTarget('run-1'), { code: 'no_target' })
})

test('cancelling a ready unmounted blank artifact marks its run target missing', async () => {
  const service = new OfficeService({
    ...dependencies(),
    prepareBlankDraft: async (input) => ({
      artifactId: 'blank-1',
      sessionId: input.sessionId,
      projectId: input.projectId,
      origin: 'blank',
      sourcePath: null,
      sourceHash: null,
      draftPath: '/sessions/session-1/artifacts/office/blank-1/blank.xlsx'
    })
  })
  const created = await service.create({
    requestId: 'create-1',
    sessionId: 'session-1',
    projectId: null,
    name: '空白草稿'
  })
  assert.equal(created.state, 'ready')
  service.bindRunTarget({
    runId: 'run-blank',
    artifactId: 'blank-1',
    sessionId: 'session-1',
    projectId: null
  })

  assert.equal(await service.cancelCreate('create-1', 'session-1'), true)
  assert.throws(() => service.resolveRunTarget('run-blank', 'session-1'), {
    code: 'target_missing'
  })
})
