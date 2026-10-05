import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  OfficeService,
  type OfficeCreateRequest,
  type OfficeImportRequest,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function dependencies(
  overrides: Partial<OfficeServiceDependencies> = {}
): OfficeServiceDependencies {
  return {
    detectRuntime: async () => ({
      state: 'available',
      binaryPath: '/officecli',
      version: '1.0.153',
      platform: 'darwin-arm64'
    }),
    prepareDraft: async () => ({
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      sourcePath: '/project/source.xlsx',
      sourceHash: 'abc',
      draftPath: '/sessions/session-1/artifacts/office/artifact-1/source.xlsx'
    }),
    prepareBlankDraft: async () => ({
      artifactId: 'blank-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      origin: 'blank',
      sourcePath: null,
      sourceHash: null,
      draftPath: '/sessions/session-1/artifacts/office/blank-1/blank.xlsx'
    }),
    prepareImportedDraft: async () => ({
      artifactId: 'import-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      kind: 'xlsx',
      origin: 'import',
      sourcePath: '/project/source.csv',
      sourceHash: 'a'.repeat(64),
      importSource: {
        path: 'source.csv',
        format: 'csv',
        delimiter: ',',
        rows: 2,
        columns: 2,
        sha256: 'a'.repeat(64)
      },
      draftPath: '/sessions/session-1/artifacts/office/import-1/source.xlsx'
    }),
    startDocument: async () => ({ residentPid: 101 }),
    adoptCreatedDocument: async () => ({ residentPid: 303 }),
    startPreview: async () => ({
      watchPid: 202,
      watchPort: 31_001,
      gatewayPort: 42_001,
      previewUrl: 'http://127.0.0.1:42001/'
    }),
    stopPreview: async () => undefined,
    closeDocument: async () => undefined,
    removeBlankDraft: async () => undefined,
    removeCreatedDraft: async () => undefined,
    validateRegisteredDraft: async () => undefined,
    assertNotOfficeArtifactPath: async () => undefined,
    resolveSelection: async () => null,
    clearSelection: async () => undefined,
    readRange: async () => {
      throw new Error('unused')
    },
    ...overrides
  }
}

const request = {
  sessionId: 'session-1',
  projectId: 'project-1',
  sourcePath: '/project/source.xlsx',
  projectLocation: { kind: 'local' as const, path: '/project', realPath: '/project' },
  allowRoots: ['/project']
}

const createRequest: OfficeCreateRequest = {
  requestId: 'create-1',
  sessionId: 'session-1',
  projectId: 'project-1',
  projectLocation: { kind: 'local', path: '/project', realPath: '/project' },
  name: '预算草稿'
}

const importRequest: OfficeImportRequest = {
  requestId: 'import-request-1',
  sessionId: 'session-1',
  projectId: 'project-1',
  projectLocation: { kind: 'local', path: '/project', realPath: '/project' },
  sourcePath: '/project/source.csv',
  allowRoots: ['/project'],
  format: 'csv'
}

test('create exposes preparing then adopts the resident created by OfficeCLI and becomes ready', async () => {
  const prepared = deferred<Awaited<ReturnType<OfficeServiceDependencies['prepareBlankDraft']>>>()
  let openCalls = 0
  let adoptCalls = 0
  const service = new OfficeService(
    dependencies({
      prepareBlankDraft: () => prepared.promise,
      startDocument: async () => {
        openCalls += 1
        return { residentPid: 101 }
      },
      adoptCreatedDocument: async () => {
        adoptCalls += 1
        return { residentPid: 303 }
      }
    })
  )

  const creating = service.create(createRequest)
  assert.deepEqual(service.statusForCreate('session-1', 'create-1'), {
    state: 'preparing',
    requestId: 'create-1'
  })
  prepared.resolve(await dependencies().prepareBlankDraft(createRequest, '/officecli'))

  const ready = await creating
  assert.equal(ready.state, 'ready')
  if (ready.state !== 'ready') throw new Error(ready.message)
  assert.equal(ready.document.origin, 'blank')
  assert.equal(ready.document.residentPid, 303)
  assert.equal(ready.document.sourcePath, null)
  assert.equal(openCalls, 0)
  assert.equal(adoptCalls, 1)
})

test('import shares a pending request, adopts its resident, and exposes the private XLSX path', async () => {
  const prepared =
    deferred<Awaited<ReturnType<NonNullable<OfficeServiceDependencies['prepareImportedDraft']>>>>()
  let prepareCalls = 0
  const service = new OfficeService(
    dependencies({
      prepareImportedDraft: async () => {
        prepareCalls += 1
        return prepared.promise
      }
    })
  )

  const first = service.importDocument(importRequest)
  const second = service.importDocument(importRequest)
  assert.deepEqual(service.statusForImport('session-1', 'import-request-1'), {
    state: 'preparing',
    requestId: 'import-request-1'
  })
  prepared.resolve(await dependencies().prepareImportedDraft!(importRequest, '/officecli', {}))
  const [left, right] = await Promise.all([first, second])

  assert.equal(prepareCalls, 1)
  if (left.state !== 'ready') throw new Error('imported document did not become ready')
  assert.equal(left.state, 'ready')
  assert.deepEqual(right, left)
  assert.equal(left.document.origin, 'import')
  assert.equal(left.document.draftPath.endsWith('/source.xlsx'), true)
  assert.equal(left.document.residentPid, 303)
})

test('a failed imported preview closes the resident and removes only the imported artifact', async () => {
  const closed: string[] = []
  const removed: string[] = []
  const service = new OfficeService(
    dependencies({
      startPreview: async () => {
        throw Object.assign(new Error('预览启动失败'), { code: 'watch-failed' })
      },
      closeDocument: async (_binaryPath, artifact) => {
        closed.push(artifact.artifactId)
      },
      removeCreatedDraft: async (artifact) => {
        removed.push(artifact.artifactId)
      }
    })
  )

  const result = await service.importDocument(importRequest)

  assert.deepEqual(result, {
    state: 'error',
    requestId: 'import-request-1',
    code: 'watch-failed',
    message: '预览启动失败'
  })
  assert.deepEqual(closed, ['import-1'])
  assert.deepEqual(removed, ['import-1'])
})

test('cancelling a preparing import closes its resident and removes its partial artifact', async () => {
  const prepared = deferred<void>()
  const adopted = deferred<{ residentPid: number }>()
  const closed: string[] = []
  const removed: string[] = []
  const service = new OfficeService(
    dependencies({
      prepareImportedDraft: async (...args) => {
        const artifact = await dependencies().prepareImportedDraft!(...args)
        prepared.resolve()
        return artifact
      },
      adoptCreatedDocument: () => adopted.promise,
      closeDocument: async (_binaryPath, artifact) => {
        closed.push(artifact.artifactId)
      },
      removeCreatedDraft: async (artifact) => {
        removed.push(artifact.artifactId)
      }
    })
  )

  const importing = service.importDocument(importRequest)
  await prepared.promise
  const cancelling = service.cancelImport('import-request-1', 'session-1')
  adopted.resolve({ residentPid: 303 })

  assert.equal(await cancelling, true)
  assert.deepEqual(await importing, {
    state: 'error',
    requestId: 'import-request-1',
    code: 'import-cancelled',
    message: '已取消 CSV/TSV 导入'
  })
  assert.deepEqual(closed, ['import-1'])
  assert.deepEqual(removed, ['import-1'])
})

test('cancelling while import readiness is loading removes a draft that became ready in the race', async () => {
  const loadStarted = deferred<void>()
  const finishLoad = deferred<{
    version: 2
    contentRevision: number
    operations: Record<string, never>
  }>()
  const closed: string[] = []
  const removed: string[] = []
  const service = new OfficeService(
    dependencies({
      loadOperationLog: async () => {
        loadStarted.resolve()
        return finishLoad.promise
      },
      closeDocument: async (_binaryPath, artifact) => {
        closed.push(artifact.artifactId)
      },
      removeCreatedDraft: async (artifact) => {
        removed.push(artifact.artifactId)
      }
    })
  )

  const importing = service.importDocument(importRequest)
  await loadStarted.promise
  const cancelling = service.cancelImport('import-request-1', 'session-1')
  finishLoad.resolve({ version: 2, contentRevision: 0, operations: {} })

  assert.equal((await importing).state, 'ready')
  assert.equal(await cancelling, true)
  assert.equal(service.statusForImport('session-1', 'import-request-1'), undefined)
  assert.deepEqual(closed, ['import-1'])
  assert.deepEqual(removed, ['import-1'])
})

test('quit deadline aborts and removes an imported artifact still preparing outside owned state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-import-quit-'))
  const partialDir = join(root, 'partial-import')
  mkdirSync(partialDir)
  let aborted = false
  let forceReleased = false
  const prepareStarted = deferred<void>()
  const service = new OfficeService(
    dependencies({
      prepareImportedDraft: async (_request, _binaryPath, control) => {
        control.onArtifactDir?.(partialDir)
        control.onDraftPath?.(join(partialDir, 'partial.xlsx'))
        prepareStarted.resolve()
        control.signal?.addEventListener('abort', () => {
          aborted = true
        })
        return new Promise(() => undefined)
      },
      forceTerminateImportedDraft: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        writeFileSync(join(partialDir, 'late-resident-write.xlsx'), 'late write')
        forceReleased = true
      }
    })
  )
  try {
    void service.importDocument(importRequest)
    await prepareStarted.promise
    const startedAt = Date.now()
    await service.dispose({ deadlineMs: 25 })

    assert.ok(Date.now() - startedAt < 250)
    assert.equal(aborted, true)
    assert.equal(forceReleased, true)
    assert.equal(existsSync(partialDir), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancelling a blank draft while it is preparing closes its resident and removes its directory', async () => {
  const prepared = deferred<void>()
  const adopted = deferred<{ residentPid: number }>()
  const closed: string[] = []
  const removed: string[] = []
  let previewCalls = 0
  const service = new OfficeService(
    dependencies({
      prepareBlankDraft: async (...args) => {
        const artifact = await dependencies().prepareBlankDraft(...args)
        prepared.resolve()
        return artifact
      },
      adoptCreatedDocument: () => adopted.promise,
      startPreview: async (...args) => {
        previewCalls += 1
        return dependencies().startPreview(...args)
      },
      closeDocument: async (_binaryPath, artifact) => {
        closed.push(artifact.artifactId)
      },
      removeBlankDraft: async (artifact) => {
        removed.push(artifact.artifactId)
      }
    })
  )

  const creating = service.create(createRequest)
  await prepared.promise
  const cancelling = service.cancelCreate('create-1', 'session-1')
  adopted.resolve({ residentPid: 303 })

  assert.equal(await cancelling, true)
  assert.deepEqual(await creating, {
    state: 'error',
    requestId: 'create-1',
    code: 'create-cancelled',
    message: '已取消创建空白 Office 草稿'
  })
  assert.deepEqual(closed, ['blank-1'])
  assert.deepEqual(removed, ['blank-1'])
  assert.equal(previewCalls, 0)
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:42001/'), false)
})

test('a create cancelled just after ready is discarded until a preview attaches', async () => {
  const stopped: string[] = []
  const closed: string[] = []
  const removed: string[] = []
  const service = new OfficeService(
    dependencies({
      stopPreview: async (document) => {
        stopped.push(document.artifactId)
      },
      closeDocument: async (_binaryPath, artifact) => {
        closed.push(artifact.artifactId)
      },
      removeBlankDraft: async (artifact) => {
        removed.push(artifact.artifactId)
      }
    })
  )
  const created = await service.create(createRequest)
  assert.equal(created.state, 'ready')

  assert.equal(await service.cancelCreate('create-1', 'session-1'), true)
  assert.deepEqual(stopped, ['blank-1'])
  assert.deepEqual(closed, ['blank-1'])
  assert.deepEqual(removed, ['blank-1'])
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:42001/'), false)
})

test('a preview failure never publishes ready and cleans the new blank artifact', async () => {
  const stopped: string[] = []
  const closed: string[] = []
  const removed: string[] = []
  const service = new OfficeService(
    dependencies({
      startPreview: async () => {
        throw Object.assign(new Error('监听启动失败'), { code: 'watch-failed' })
      },
      stopPreview: async (artifact) => {
        stopped.push(artifact.artifactId)
      },
      closeDocument: async (_binaryPath, artifact) => {
        closed.push(artifact.artifactId)
      },
      removeBlankDraft: async (artifact) => {
        removed.push(artifact.artifactId)
      }
    })
  )

  const result = await service.create(createRequest)

  assert.deepEqual(result, {
    state: 'error',
    requestId: 'create-1',
    code: 'watch-failed',
    message: '监听启动失败'
  })
  assert.equal(
    service.statusForSource('session-1', '/sessions/session-1/artifacts/office/blank-1/blank.xlsx'),
    undefined
  )
  assert.deepEqual(stopped, ['blank-1'])
  assert.deepEqual(closed, ['blank-1'])
  assert.deepEqual(removed, ['blank-1'])
})

test('an unknown create failure does not expose internal paths', async () => {
  const service = new OfficeService(
    dependencies({
      startPreview: async () => {
        throw new Error('spawn /private/internal/officecli on port 43123 failed')
      }
    })
  )

  assert.deepEqual(await service.create(createRequest), {
    state: 'error',
    requestId: 'create-1',
    code: 'create-failed',
    message: '空白 Office 草稿创建失败'
  })
})

test('a created blank draft is validated before resident adoption', async () => {
  let adoptCalls = 0
  const closed: string[] = []
  const removed: string[] = []
  const service = new OfficeService(
    dependencies({
      validateRegisteredDraft: async () => {
        throw Object.assign(new Error('草稿文件校验失败'), { code: 'draft-symlink' })
      },
      adoptCreatedDocument: async () => {
        adoptCalls += 1
        return { residentPid: 303 }
      },
      closeDocument: async (_binaryPath, artifact) => {
        closed.push(artifact.artifactId)
      },
      removeBlankDraft: async (artifact) => {
        removed.push(artifact.artifactId)
      }
    })
  )

  assert.deepEqual(await service.create(createRequest), {
    state: 'error',
    requestId: 'create-1',
    code: 'draft-symlink',
    message: '草稿文件校验失败'
  })
  assert.equal(adoptCalls, 0)
  assert.deepEqual(closed, ['blank-1'])
  assert.deepEqual(removed, ['blank-1'])
})

test('each blank create owns a distinct artifact, directory, and preview port', async () => {
  let sequence = 0
  const service = new OfficeService(
    dependencies({
      prepareBlankDraft: async (input) => {
        sequence += 1
        const artifactId = `blank-${sequence}`
        return {
          artifactId,
          sessionId: input.sessionId,
          projectId: input.projectId,
          origin: 'blank',
          sourcePath: null,
          sourceHash: null,
          draftPath: `/sessions/${input.sessionId}/artifacts/office/${artifactId}/blank.xlsx`
        }
      },
      startPreview: async () => ({
        watchPid: 200 + sequence,
        watchPort: 31_000 + sequence,
        gatewayPort: 42_000 + sequence,
        previewUrl: `http://127.0.0.1:${42_000 + sequence}/`
      })
    })
  )

  const first = await service.create(createRequest)
  const second = await service.create({ ...createRequest, requestId: 'create-2' })
  assert.equal(first.state, 'ready')
  assert.equal(second.state, 'ready')
  if (first.state !== 'ready' || second.state !== 'ready') throw new Error('create failed')
  assert.notEqual(first.document.artifactId, second.document.artifactId)
  assert.notEqual(first.document.draftPath, second.document.draftPath)
  assert.notEqual(first.document.gatewayPort, second.document.gatewayPort)
})

test('opening a registered blank draft path reuses its artifact instead of copying it', async () => {
  let copyCalls = 0
  const validated: string[] = []
  const service = new OfficeService(
    dependencies({
      prepareDraft: async (...args) => {
        copyCalls += 1
        return dependencies().prepareDraft(...args)
      },
      validateRegisteredDraft: async (artifact) => {
        validated.push(artifact.artifactId)
      }
    })
  )
  const created = await service.create(createRequest)
  assert.equal(created.state, 'ready')
  if (created.state !== 'ready') throw new Error(created.message)

  const opened = await service.open({ ...request, sourcePath: created.document.draftPath })

  assert.equal(opened.state, 'ready')
  if (opened.state !== 'ready') throw new Error(opened.message)
  assert.equal(opened.document.artifactId, created.document.artifactId)
  assert.equal(opened.document.gatewayPort, created.document.gatewayPort)
  assert.deepEqual(validated, ['blank-1', 'blank-1'])
  assert.equal(copyCalls, 0)
})

test('a closed blank draft reopens with the same artifact identity instead of becoming a source copy', async () => {
  let copyCalls = 0
  let residentStarts = 0
  const service = new OfficeService(
    dependencies({
      prepareDraft: async (...args) => {
        copyCalls += 1
        return dependencies().prepareDraft(...args)
      },
      startDocument: async () => {
        residentStarts += 1
        return { residentPid: 404 }
      }
    })
  )
  const created = await service.create(createRequest)
  assert.equal(created.state, 'ready')
  if (created.state !== 'ready') throw new Error(created.message)
  const openRequest = { ...request, sourcePath: created.document.draftPath }
  const attached = await service.open(openRequest)
  assert.equal(attached.state, 'ready')
  assert.equal(await service.close(created.document.artifactId, created.document.sessionId), true)

  const reopened = await service.open(openRequest)

  assert.equal(reopened.state, 'ready')
  if (reopened.state !== 'ready') throw new Error(reopened.message)
  assert.equal(reopened.document.artifactId, created.document.artifactId)
  assert.equal(residentStarts, 1)
  assert.equal(copyCalls, 0)
})

test('concurrent creates with the same request id share one artifact and one resource slot', async () => {
  const gate = deferred<void>()
  let prepareCalls = 0
  const service = new OfficeService(
    dependencies({
      prepareBlankDraft: async (...args) => {
        prepareCalls += 1
        await gate.promise
        return dependencies().prepareBlankDraft(...args)
      }
    })
  )

  const creating = Array.from({ length: 4 }, () => service.create(createRequest))
  gate.resolve()
  const results = await Promise.all(creating)

  assert.equal(prepareCalls, 1)
  assert.ok(results.every((result) => result.state === 'ready'))
  assert.deepEqual(
    results.map((result) => (result.state === 'ready' ? result.document.artifactId : null)),
    ['blank-1', 'blank-1', 'blank-1', 'blank-1']
  )
})

test('an unregistered or foreign Office artifact path is rejected before source copying', async () => {
  let copyCalls = 0
  const service = new OfficeService(
    dependencies({
      assertNotOfficeArtifactPath: async () => {
        throw Object.assign(new Error('不能把未登记的 Office 草稿作为源文件打开'), {
          code: 'unregistered-draft'
        })
      },
      prepareDraft: async (...args) => {
        copyCalls += 1
        return dependencies().prepareDraft(...args)
      }
    })
  )

  const result = await service.open({
    ...request,
    sourcePath: '/sessions/other/artifacts/office/forged/report.xlsx'
  })

  assert.deepEqual(result, {
    state: 'error',
    sourcePath: '/sessions/other/artifacts/office/forged/report.xlsx',
    code: 'unregistered-draft',
    message: '不能把未登记的 Office 草稿作为源文件打开'
  })
  assert.equal(copyCalls, 0)
})

test('the cross-kind limit reclaims the oldest of two XLSX and two DOCX drafts', async () => {
  let sequence = 0
  const stopped: string[] = []
  const closed: string[] = []
  const service = new OfficeService(
    dependencies({
      prepareBlankDraft: async (input) => {
        sequence += 1
        const artifactId = `blank-${sequence}`
        const kind = input.kind ?? 'xlsx'
        return {
          artifactId,
          sessionId: input.sessionId,
          projectId: input.projectId,
          kind,
          origin: 'blank',
          sourcePath: null,
          sourceHash: null,
          draftPath: `/sessions/${input.sessionId}/artifacts/office/${artifactId}/blank.${kind}`
        }
      },
      stopPreview: async (document) => {
        stopped.push(document.artifactId)
      },
      closeDocument: async (_binaryPath, document) => {
        closed.push(document.artifactId)
      }
    })
  )
  for (const [requestId, kind] of [
    ['create-1', 'xlsx'],
    ['create-2', 'docx'],
    ['create-3', 'xlsx']
  ] as const) {
    assert.equal((await service.create({ ...createRequest, requestId, kind })).state, 'ready')
  }

  const fourth = await service.create({ ...createRequest, requestId: 'create-4', kind: 'docx' })
  assert.equal(fourth.state, 'ready')
  if (fourth.state === 'ready') assert.equal(fourth.document.kind, 'docx')
  assert.deepEqual(stopped, ['blank-1'])
  assert.deepEqual(closed, ['blank-1'])

  const reopened = await service.open({
    ...request,
    sourcePath: '/sessions/session-1/artifacts/office/blank-1/blank.xlsx'
  })
  assert.equal(reopened.state, 'ready')
  if (reopened.state === 'ready') assert.equal(reopened.document.artifactId, 'blank-1')
  assert.deepEqual(stopped, ['blank-1', 'blank-2'])
})

test('the three-document limit is shared across XLSX, DOCX, and PPTX', async () => {
  let sequence = 0
  const stopped: string[] = []
  const service = new OfficeService(
    dependencies({
      prepareBlankDraft: async (input) => {
        sequence += 1
        const artifactId = `mixed-${sequence}`
        const kind = input.kind ?? 'xlsx'
        return {
          artifactId,
          sessionId: input.sessionId,
          projectId: input.projectId,
          kind,
          origin: 'blank',
          sourcePath: null,
          sourceHash: null,
          draftPath: `/sessions/${input.sessionId}/artifacts/office/${artifactId}/blank.${kind}`
        }
      },
      stopPreview: async (document) => {
        stopped.push(document.artifactId)
      }
    })
  )

  for (const [requestId, kind] of [
    ['mixed-create-1', 'xlsx'],
    ['mixed-create-2', 'docx'],
    ['mixed-create-3', 'pptx'],
    ['mixed-create-4', 'xlsx']
  ] as const) {
    const created = await service.create({ ...createRequest, requestId, kind })
    assert.equal(created.state, 'ready')
  }

  assert.deepEqual(stopped, ['mixed-1'])
})

test('a third import succeeds when two ready documents are not reclaimable', async () => {
  const stopped: string[] = []
  const service = new OfficeService(
    dependencies({
      prepareDraft: async (input) => {
        const name = input.sourcePath.split('/').pop()!.replace('.xlsx', '')
        return {
          artifactId: `artifact-${name}`,
          sessionId: input.sessionId,
          projectId: input.projectId,
          sourcePath: input.sourcePath,
          sourceHash: 'hash',
          draftPath: `/sessions/${input.sessionId}/artifacts/office/artifact-${name}/${name}.xlsx`
        }
      },
      stopPreview: async (document) => {
        stopped.push(document.artifactId)
      }
    })
  )
  for (const name of ['first.xlsx', 'second.xlsx']) {
    assert.equal(
      (await service.open({ ...request, sourcePath: `/project/${name}` })).state,
      'ready'
    )
  }

  const imported = await service.importDocument(importRequest)

  assert.equal(imported.state, 'ready')
  assert.deepEqual(stopped, [])
})

test('a PPTX slide-count update is reflected by subsequent status reads', async () => {
  const sourcePath = '/project/slides.pptx'
  const service = new OfficeService(
    dependencies({
      prepareDraft: async () => ({
        artifactId: 'artifact-pptx',
        sessionId: 'session-1',
        projectId: 'project-1',
        kind: 'pptx',
        sourcePath,
        sourceHash: 'abc',
        draftPath: '/sessions/session-1/artifacts/office/artifact-pptx/slides.pptx'
      }),
      startPreview: async () => ({
        watchPid: 202,
        watchPort: 31_001,
        gatewayPort: 42_001,
        previewUrl: 'http://127.0.0.1:42001/',
        previewState: 'ready',
        slideCount: 0
      })
    })
  )
  const opened = await service.open({ ...request, sourcePath })
  assert.equal(opened.state, 'ready')
  service.publishPreviewSlideCount('artifact-pptx', 1)

  const status = service.statusForSource('session-1', sourcePath)
  assert.equal(status?.state, 'ready')
  if (status?.state === 'ready') assert.equal(status.document.slideCount, 1)
})

test('failed blank cleanup stays owned and is retried by dispose', async () => {
  let closeAttempts = 0
  const removed: string[] = []
  const service = new OfficeService(
    dependencies({
      startPreview: async () => {
        throw Object.assign(new Error('监听失败'), { code: 'watch-failed' })
      },
      closeDocument: async () => {
        closeAttempts += 1
        if (closeAttempts === 1) throw new Error('resident still alive')
      },
      removeBlankDraft: async (artifact) => {
        removed.push(artifact.artifactId)
      }
    })
  )

  assert.deepEqual(await service.create(createRequest), {
    state: 'error',
    requestId: 'create-1',
    code: 'cleanup-failed',
    message: '空白 Office 草稿清理失败'
  })
  assert.deepEqual(removed, [])

  await service.dispose()
  assert.equal(closeAttempts, 2)
  assert.deepEqual(removed, ['blank-1'])
})

test('a pending cleanup still consumes one active-document slot', async () => {
  let sequence = 0
  let failPreview = true
  const service = new OfficeService(
    dependencies({
      prepareBlankDraft: async (input) => {
        sequence += 1
        const artifactId = `blank-${sequence}`
        return {
          artifactId,
          sessionId: input.sessionId,
          projectId: input.projectId,
          origin: 'blank',
          sourcePath: null,
          sourceHash: null,
          draftPath: `/sessions/${input.sessionId}/artifacts/office/${artifactId}/blank.xlsx`
        }
      },
      startPreview: async (...args) => {
        if (failPreview) {
          failPreview = false
          throw Object.assign(new Error('监听失败'), { code: 'watch-failed' })
        }
        return dependencies().startPreview(...args)
      },
      closeDocument: async () => {
        throw new Error('resident still alive')
      }
    })
  )

  assert.equal((await service.create(createRequest)).state, 'error')
  assert.equal((await service.create({ ...createRequest, requestId: 'create-2' })).state, 'ready')
  assert.equal((await service.create({ ...createRequest, requestId: 'create-3' })).state, 'ready')
  assert.equal((await service.create({ ...createRequest, requestId: 'create-4' })).state, 'error')
  assert.equal(service.statusForCreate('session-1', 'create-4')?.state, 'error')
})

test('open reports preparing until the Office runtime is ready', async () => {
  const runtime = deferred<Awaited<ReturnType<OfficeServiceDependencies['detectRuntime']>>>()
  const service = new OfficeService(dependencies({ detectRuntime: () => runtime.promise }))

  const opening = service.open(request)
  assert.deepEqual(service.statusForSource(request.sessionId, request.sourcePath), {
    state: 'preparing',
    sourcePath: request.sourcePath
  })

  runtime.resolve({
    state: 'available',
    binaryPath: '/officecli',
    version: '1.0.153',
    platform: 'darwin-arm64'
  })
  const ready = await opening
  assert.equal(ready.state, 'ready')
  assert.equal(ready.document.previewUrl, 'http://127.0.0.1:42001/')
})

test('open returns a readable runtime error without preparing a draft', async () => {
  let draftCalls = 0
  const service = new OfficeService(
    dependencies({
      detectRuntime: async () => ({
        state: 'missing',
        expectedPath: '/missing/officecli',
        hint: '运行 bun run office:fetch'
      }),
      prepareDraft: async () => {
        draftCalls += 1
        throw new Error('must not prepare')
      }
    })
  )

  const result = await service.open(request)
  assert.deepEqual(result, {
    state: 'error',
    sourcePath: request.sourcePath,
    code: 'missing',
    message: 'OfficeCLI 未安装。运行 bun run office:fetch'
  })
  assert.equal(draftCalls, 0)
})

test('an unexpected runtime probe failure becomes an error state', async () => {
  const service = new OfficeService(
    dependencies({ detectRuntime: async () => Promise.reject(new Error('manifest unreadable')) })
  )

  assert.deepEqual(await service.open(request), {
    state: 'error',
    sourcePath: request.sourcePath,
    code: 'runtime-probe-failed',
    message: 'manifest unreadable'
  })
})

test('opening the same session source is idempotent', async () => {
  let draftCalls = 0
  let previewCalls = 0
  const service = new OfficeService(
    dependencies({
      prepareDraft: async () => {
        draftCalls += 1
        return dependencies().prepareDraft(request)
      },
      startPreview: async () => {
        previewCalls += 1
        return dependencies().startPreview('/officecli', await dependencies().prepareDraft(request))
      }
    })
  )

  const [first, second] = await Promise.all([service.open(request), service.open(request)])
  assert.equal(first.state, 'ready')
  assert.deepEqual(second, first)
  assert.equal(draftCalls, 1)
  assert.equal(previewCalls, 1)
})

test('a fourth live document is rejected without evicting an existing document', async () => {
  const service = new OfficeService(
    dependencies({
      prepareDraft: async (input) => ({
        artifactId: input.sourcePath,
        sessionId: input.sessionId,
        projectId: input.projectId,
        sourcePath: input.sourcePath,
        sourceHash: 'hash',
        draftPath: `/draft${input.sourcePath}`
      })
    })
  )
  for (const name of ['a.xlsx', 'b.xlsx', 'c.xlsx']) {
    assert.equal(
      (await service.open({ ...request, sourcePath: `/project/${name}` })).state,
      'ready'
    )
  }

  const rejected = await service.open({ ...request, sourcePath: '/project/d.xlsx' })
  assert.deepEqual(rejected, {
    state: 'error',
    sourcePath: '/project/d.xlsx',
    code: 'resource-limit',
    message: '最多可同时存活 3 个 Office 文档；当前占用：面板打开 3'
  })
})

test('close releases only the owned preview and resident and is idempotent', async () => {
  const stopped: string[] = []
  const closed: string[] = []
  const service = new OfficeService(
    dependencies({
      stopPreview: async (document) => {
        stopped.push(document.artifactId)
      },
      closeDocument: async (_binaryPath, artifact) => {
        closed.push(artifact.artifactId)
      }
    })
  )
  await service.open(request)
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:42001/'), true)
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:31001/'), false)

  assert.equal(await service.close('not-owned', 'session-1'), false)
  assert.equal(await service.close('artifact-1', 'other-session'), false)
  assert.equal(await service.close('artifact-1', 'session-1'), true)
  assert.equal(await service.close('artifact-1', 'session-1'), false)
  assert.deepEqual(stopped, ['artifact-1'])
  assert.deepEqual(closed, ['artifact-1'])
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:42001/'), false)
  assert.equal(service.statusForSource(request.sessionId, request.sourcePath), undefined)
})

test('close stops preview before closing the resident', async () => {
  const previewStopped = deferred<void>()
  const order: string[] = []
  const service = new OfficeService(
    dependencies({
      stopPreview: async () => {
        order.push('stop-preview')
        await previewStopped.promise
      },
      closeDocument: async () => {
        order.push('close-resident')
      }
    })
  )
  await service.open(request)

  const closing = service.close('artifact-1', 'session-1')
  await Promise.resolve()
  assert.deepEqual(order, ['stop-preview'])
  previewStopped.resolve()
  await closing
  assert.deepEqual(order, ['stop-preview', 'close-resident'])
})

test('idempotent opens keep the document alive until every caller closes it', async () => {
  const stopped: string[] = []
  const service = new OfficeService(
    dependencies({
      stopPreview: async (document) => {
        stopped.push(document.artifactId)
      }
    })
  )
  await Promise.all([service.open(request), service.open(request)])

  assert.equal(await service.close('artifact-1', 'session-1'), true)
  assert.deepEqual(stopped, [])
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:42001/'), true)
  assert.equal(await service.close('artifact-1', 'session-1'), true)
  assert.deepEqual(stopped, ['artifact-1'])
})

test('a preview startup failure closes the resident and becomes an error state', async () => {
  const closed: string[] = []
  const service = new OfficeService(
    dependencies({
      startPreview: async () => {
        throw Object.assign(new Error('watch 无法启动'), { code: 'watch-failed' })
      },
      closeDocument: async (_binaryPath, artifact) => {
        closed.push(artifact.artifactId)
      }
    })
  )

  const result = await service.open(request)
  assert.deepEqual(result, {
    state: 'error',
    sourcePath: request.sourcePath,
    code: 'watch-failed',
    message: 'watch 无法启动'
  })
  assert.deepEqual(closed, ['artifact-1'])
})

test('a source preview partial-cleanup failure remains owned for dispose retry', async () => {
  let stopAttempts = 0
  let closeAttempts = 0
  const service = new OfficeService(
    dependencies({
      startPreview: async () => {
        throw Object.assign(new Error('gateway 无法启动'), { code: 'gateway-failed' })
      },
      stopPreview: async () => {
        stopAttempts += 1
        if (stopAttempts === 1) throw new Error('unwatch failed')
      },
      closeDocument: async () => {
        closeAttempts += 1
      }
    })
  )

  assert.deepEqual(await service.open(request), {
    state: 'error',
    sourcePath: request.sourcePath,
    code: 'cleanup-failed',
    message: 'Office 资源清理失败'
  })
  assert.equal(closeAttempts, 0)

  await service.dispose()
  assert.equal(stopAttempts, 2)
  assert.equal(closeAttempts, 1)
})

test('dispose releases every owned document even when one cleanup fails', async () => {
  const stopped: string[] = []
  const closed: string[] = []
  let failFirst = true
  const service = new OfficeService(
    dependencies({
      prepareDraft: async (input) => ({
        artifactId: input.sourcePath,
        sessionId: input.sessionId,
        projectId: input.projectId,
        sourcePath: input.sourcePath,
        sourceHash: 'hash',
        draftPath: `/draft${input.sourcePath}`
      }),
      stopPreview: async (document) => {
        stopped.push(document.artifactId)
        if (failFirst && document.artifactId.endsWith('a.xlsx')) throw new Error('still alive')
      },
      closeDocument: async (_binaryPath, artifact) => {
        closed.push(artifact.artifactId)
      }
    })
  )
  await service.open({ ...request, sourcePath: '/project/a.xlsx' })
  await service.open({ ...request, sourcePath: '/project/b.xlsx' })

  await assert.rejects(service.dispose(), /still alive/)
  assert.deepEqual(stopped.sort(), ['/project/a.xlsx', '/project/b.xlsx'])
  assert.deepEqual(closed, ['/project/b.xlsx'])
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:42001/'), true)

  failFirst = false
  await service.dispose()
  assert.deepEqual(closed.sort(), ['/project/a.xlsx', '/project/b.xlsx'])
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:42001/'), false)
})

test('dispose waits for a preparing document and releases it after startup', async () => {
  const runtime = deferred<Awaited<ReturnType<OfficeServiceDependencies['detectRuntime']>>>()
  const stopped: string[] = []
  const service = new OfficeService(
    dependencies({
      detectRuntime: () => runtime.promise,
      stopPreview: async (document) => {
        stopped.push(document.artifactId)
      }
    })
  )
  const opening = service.open(request)
  const disposing = service.dispose()
  runtime.resolve({
    state: 'available',
    binaryPath: '/officecli',
    version: '1.0.153',
    platform: 'darwin-arm64'
  })

  await Promise.all([opening, disposing])
  assert.deepEqual(stopped, ['artifact-1'])
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:42001/'), false)
})

test('closeSession releases only documents owned by the deleted session', async () => {
  const stopped: string[] = []
  const service = new OfficeService(
    dependencies({
      prepareDraft: async (input) => ({
        artifactId: input.sessionId,
        sessionId: input.sessionId,
        projectId: input.projectId,
        sourcePath: input.sourcePath,
        sourceHash: 'hash',
        draftPath: `/draft/${input.sessionId}.xlsx`
      }),
      startPreview: async (_binary, artifact) => ({
        watchPid: 202,
        watchPort: 31_001,
        gatewayPort: artifact.sessionId === 'session-1' ? 42_001 : 42_002,
        previewUrl: `http://127.0.0.1:${artifact.sessionId === 'session-1' ? 42_001 : 42_002}/`
      }),
      stopPreview: async (document) => {
        stopped.push(document.artifactId)
      }
    })
  )
  await service.open(request)
  await service.open({ ...request, sessionId: 'session-2', sourcePath: '/project/b.xlsx' })

  await service.closeSession('session-1')
  assert.deepEqual(stopped, ['session-1'])
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:42001/'), false)
  assert.equal(service.ownsPreviewUrl('http://127.0.0.1:42002/'), true)
})
