import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { createOfficeService } from '../src/main/agent/office/office-service-factory'
import {
  artifactDirectories,
  cliJson,
  closeTransient,
  createOfficeRecoverySession as createSession,
  formatSource,
  officeRecoveryIntegrationOptions as options,
  psAvailable,
  residentProcesses,
  sha256,
  workbookEvidence
} from './helpers/officeReopenRecoveryHarness'

test(
  'reopen preserves values, formulas, formats, Chinese sheets, and creates a new draft after source change',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office reopen integration '))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    const sourcePath = join(root, 'book.xlsx')
    copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx'), sourcePath)
    const service = createOfficeService()
    try {
      await formatSource(sourcePath)
      const sourceEvidence = await workbookEvidence(sourcePath)
      await closeTransient(sourcePath)
      const sourceHash = sha256(sourcePath)
      const session = createSession(root)
      const request = {
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [root]
      }
      const first = await service.open(request)
      assert.equal(first.state, 'ready')
      if (first.state !== 'ready') throw new Error(first.message)
      assert.equal(await service.close(first.document.artifactId, session.sessionId), true)

      const reopened = await service.open(request)
      assert.equal(reopened.state, 'ready')
      if (reopened.state !== 'ready') throw new Error(reopened.message)
      assert.equal(reopened.document.artifactId, first.document.artifactId)
      assert.equal(artifactDirectories(session.dir).length, 1)
      assert.deepEqual(await workbookEvidence(reopened.document.draftPath), sourceEvidence)
      assert.equal(sha256(sourcePath), sourceHash)
      assert.equal(await service.close(reopened.document.artifactId, session.sessionId), true)
      const firstDraftHash = sha256(first.document.draftPath)

      await cliJson(['set', sourcePath, '/说明/A2', '--prop', 'value=源文件新版本'])
      await cliJson(['save', sourcePath])
      await closeTransient(sourcePath)
      const changedSourceHash = sha256(sourcePath)
      const changed = await service.open(request)
      assert.equal(changed.state, 'ready')
      if (changed.state !== 'ready') throw new Error(changed.message)
      assert.notEqual(changed.document.artifactId, first.document.artifactId)
      assert.deepEqual(changed.restoreNotice, { kind: 'source_changed' })
      assert.equal(sha256(first.document.draftPath), firstDraftHash)
      assert.equal(artifactDirectories(session.dir).length, 2)
      assert.equal(sha256(sourcePath), changedSourceHash)
      const otherSession = createSession(root)
      const other = await service.open({ ...request, sessionId: otherSession.sessionId })
      assert.equal(other.state, 'ready')
      if (other.state !== 'ready') throw new Error(other.message)
      assert.notEqual(other.document.artifactId, changed.document.artifactId)
      assert.notEqual(other.document.draftPath, changed.document.draftPath)
      assert.equal(artifactDirectories(otherSession.dir).length, 1)
    } finally {
      await service.dispose().catch(() => undefined)
      await closeTransient(sourcePath).catch(() => undefined)
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'restart restores saved revision, receipts, outputs, reads, and continued writes',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office restart integration '))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    const sourcePath = join(root, 'book.xlsx')
    copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx'), sourcePath)
    const sourceHash = sha256(sourcePath)
    const session = createSession(root)
    const request = {
      sessionId: session.sessionId,
      projectId: null,
      sourcePath,
      allowRoots: [root]
    }
    const first = createOfficeService()
    const second = createOfficeService()
    const outputService = createOfficeService()
    try {
      const opened = await first.open(request)
      assert.equal(opened.state, 'ready')
      if (opened.state !== 'ready') throw new Error(opened.message)
      await first.applyHumanCellEdit(
        opened.document.artifactId,
        { sheet: 'Sheet1', cell: 'A2', text: '人工恢复值' },
        { operationId: 'human-before-restart' }
      )
      first.bindRunTarget({
        runId: 'agent-before-restart',
        artifactId: opened.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const agentRequest = {
        operation: { type: 'set_cell' as const, sheet: 'Sheet1', cell: 'B2', value: 42 },
        baseRevision: 1
      }
      await first.applyWriteRequest('agent-before-restart', agentRequest, {
        operationId: 'agent-before-restart'
      })
      const output = await first.saveAsDocument(
        opened.document.artifactId,
        session.sessionId,
        root,
        join(root, 'saved-output.xlsx')
      )
      assert.equal(await first.close(opened.document.artifactId, session.sessionId), true)
      await first.dispose()

      const outputSession = createSession(root)
      const reopenedOutput = await outputService.open({
        sessionId: outputSession.sessionId,
        projectId: null,
        sourcePath: join(root, 'saved-output.xlsx'),
        allowRoots: [root]
      })
      assert.equal(reopenedOutput.state, 'ready')
      if (reopenedOutput.state !== 'ready') throw new Error(reopenedOutput.message)
      outputService.bindRunTarget({
        runId: 'saved-output-read',
        artifactId: reopenedOutput.document.artifactId,
        sessionId: outputSession.sessionId,
        projectId: null
      })
      const outputRead = await outputService.readRange('saved-output-read', {
        sheet: 'Sheet1',
        range: 'A2:B4'
      })
      assert.deepEqual(
        'cells' in outputRead ? outputRead.cells.slice(0, 2).map((cell) => cell.value) : [],
        ['人工恢复值', 42]
      )
      assert.equal(
        'cells' in outputRead
          ? outputRead.cells.find((cell) => cell.ref === 'B4')?.formula
          : undefined,
        '=SUM(B2:B3)'
      )
      await outputService.dispose()

      const restored = await second.open(request)
      assert.equal(restored.state, 'ready')
      if (restored.state !== 'ready') throw new Error(restored.message)
      assert.equal(restored.document.artifactId, opened.document.artifactId)
      assert.deepEqual(restored.restoreNotice, {
        kind: 'recovered',
        hasUnsavedChanges: false
      })
      assert.equal(restored.lastSavedRevision, 2)
      second.bindRunTarget({
        runId: 'agent-after-restart',
        artifactId: restored.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const read = await second.readRange('agent-after-restart', {
        sheet: 'Sheet1',
        range: 'A2:B2'
      })
      assert.equal(read.revision, 2)
      assert.deepEqual('cells' in read ? read.cells.map((cell) => cell.value) : [], [
        '人工恢复值',
        42
      ])
      const replay = await second.applyWriteRequest('agent-after-restart', agentRequest, {
        operationId: 'agent-before-restart'
      })
      assert.equal(replay.deduplicated, true)
      assert.equal(
        await second.resolveOutputPath(
          restored.document.artifactId,
          session.sessionId,
          root,
          output.outputId
        ),
        join(root, 'saved-output.xlsx')
      )
      const continued = await second.applyWriteRequest(
        'agent-after-restart',
        {
          operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'B3', value: 43 },
          baseRevision: 2
        },
        { operationId: 'agent-after-restart' }
      )
      assert.equal(continued.revision, 3)
      assert.equal(sha256(sourcePath), sourceHash)
    } finally {
      await outputService.dispose().catch(() => undefined)
      await second.dispose().catch(() => undefined)
      await first.dispose().catch(() => undefined)
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'a tampered saved draft stays readable but frozen, and fresh creates a separate artifact',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office tampered restart integration '))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    const sourcePath = join(root, 'book.xlsx')
    copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx'), sourcePath)
    const sourceHash = sha256(sourcePath)
    const session = createSession(root)
    const request = {
      sessionId: session.sessionId,
      projectId: null,
      sourcePath,
      allowRoots: [root]
    }
    const first = createOfficeService()
    const second = createOfficeService()
    try {
      const opened = await first.open(request)
      assert.equal(opened.state, 'ready')
      if (opened.state !== 'ready') throw new Error(opened.message)
      await first.applyHumanCellEdit(
        opened.document.artifactId,
        { sheet: 'Sheet1', cell: 'A2', text: '已确认内容' },
        { operationId: 'saved-before-tamper' }
      )
      assert.equal(await first.close(opened.document.artifactId, session.sessionId), true)
      await first.dispose()

      await cliJson(['set', opened.document.draftPath, '/Sheet1/A2', '--prop', 'value=外部篡改'])
      await cliJson(['save', opened.document.draftPath])
      await closeTransient(opened.document.draftPath)
      const tamperedHash = sha256(opened.document.draftPath)

      const restored = await second.open(request)
      assert.equal(restored.state, 'ready')
      if (restored.state !== 'ready') throw new Error(restored.message)
      assert.equal(restored.freezeState, 'unknown')
      assert.deepEqual(restored.restoreNotice, { kind: 'draft_hash_mismatch' })
      second.bindRunTarget({
        runId: 'tampered-read',
        artifactId: restored.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const read = await second.readRange('tampered-read', { sheet: 'Sheet1', range: 'A2' })
      assert.deepEqual('cells' in read ? read.cells.map((cell) => cell.value) : [], ['外部篡改'])
      assert.throws(() => second.assertWritable(restored.document.artifactId), {
        code: 'document_frozen'
      })

      const fresh = await second.open({ ...request, fresh: true })
      assert.equal(fresh.state, 'ready')
      if (fresh.state !== 'ready') throw new Error(fresh.message)
      assert.notEqual(fresh.document.artifactId, restored.document.artifactId)
      assert.equal(sha256(restored.document.draftPath), tamperedHash)
      assert.equal(artifactDirectories(session.dir).length, 2)
      assert.equal(sha256(sourcePath), sourceHash)
    } finally {
      await second.dispose().catch(() => undefined)
      await first.dispose().catch(() => undefined)
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'restart handles residual processes conservatively and never targets another draft',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office stale restart integration '))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    const sourcePath = join(root, 'book.xlsx')
    const otherSourcePath = join(root, 'other.xlsx')
    copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx'), sourcePath)
    copyFileSync(sourcePath, otherSourcePath)
    const session = createSession(root)
    const otherSession = createSession(root)
    const first = createOfficeService()
    const other = createOfficeService()
    const replacement = createOfficeService()
    try {
      const opened = await first.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [root]
      })
      const unrelated = await other.open({
        sessionId: otherSession.sessionId,
        projectId: null,
        sourcePath: otherSourcePath,
        allowRoots: [root]
      })
      assert.equal(opened.state, 'ready')
      assert.equal(unrelated.state, 'ready')
      if (opened.state !== 'ready' || unrelated.state !== 'ready') throw new Error('open failed')

      const draftDirectory = (document: { draftPath: string }): string =>
        dirname(document.draftPath)
      const staleBefore = psAvailable() ? residentProcesses(draftDirectory(opened.document)) : []
      const unrelatedBefore = psAvailable()
        ? residentProcesses(draftDirectory(unrelated.document))
        : []
      const restored = await replacement.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [root]
      })
      if (psAvailable()) {
        assert.equal(restored.state, 'ready')
        assert.ok(other.statusForSource(otherSession.sessionId, otherSourcePath)?.state === 'ready')
        // Process-level facts: the stale resident of this draft was really stopped and replaced
        // by exactly one new one, and the resident of the unrelated draft was never touched.
        assert.equal(staleBefore.length, 1, 'the abandoned resident must be visible before restart')
        assert.equal(unrelatedBefore.length, 1)
        if (restored.state !== 'ready') throw new Error('expected a restored draft')
        const staleAfter = residentProcesses(draftDirectory(restored.document))
        assert.equal(staleAfter.length, 1, 'exactly one resident must serve the restored draft')
        assert.notEqual(
          staleAfter[0].pid,
          staleBefore[0].pid,
          'the stale resident was not replaced'
        )
        assert.deepEqual(
          residentProcesses(draftDirectory(unrelated.document)).map((entry) => entry.pid),
          unrelatedBefore.map((entry) => entry.pid),
          'the unrelated draft resident must keep running untouched'
        )
      } else {
        assert.equal(restored.state, 'error')
        if (restored.state !== 'error') throw new Error('expected conservative failure')
        assert.equal(restored.code, 'stale_process_unverified')
        assert.ok(other.statusForSource(otherSession.sessionId, otherSourcePath)?.state === 'ready')
      }
    } finally {
      await replacement.dispose().catch(() => undefined)
      await first.dispose().catch(() => undefined)
      await other.dispose().catch(() => undefined)
      await closeTransient(sourcePath).catch(() => undefined)
      await closeTransient(otherSourcePath).catch(() => undefined)
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'missing and corrupt drafts fail closed while fresh preserves their artifact directories',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office broken draft integration '))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    try {
      for (const scenario of ['draft_missing', 'draft_corrupt'] as const) {
        const sourcePath = join(root, `${scenario}.xlsx`)
        copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx'), sourcePath)
        const sourceHash = sha256(sourcePath)
        const session = createSession(root)
        const request = {
          sessionId: session.sessionId,
          projectId: null,
          sourcePath,
          allowRoots: [root]
        }
        const first = createOfficeService()
        const second = createOfficeService()
        try {
          const opened = await first.open(request)
          assert.equal(opened.state, 'ready')
          if (opened.state !== 'ready') throw new Error(opened.message)
          assert.equal(await first.close(opened.document.artifactId, session.sessionId), true)
          await first.dispose()
          if (scenario === 'draft_missing') rmSync(opened.document.draftPath)
          else writeFileSync(opened.document.draftPath, 'corrupt draft')
          const oldDirectory = dirname(opened.document.draftPath)

          const failed = await second.open(request)
          assert.equal(failed.state, 'error')
          if (failed.state !== 'error') throw new Error('broken draft unexpectedly opened')
          assert.equal(failed.code, scenario)
          assert.equal(failed.canRecreateFromSource, true)
          const fresh = await second.open({ ...request, fresh: true })
          assert.equal(fresh.state, 'ready')
          if (fresh.state !== 'ready') throw new Error(fresh.message)
          assert.notEqual(fresh.document.artifactId, opened.document.artifactId)
          assert.equal(existsSync(oldDirectory), true)
          assert.equal(sha256(sourcePath), sourceHash)
        } finally {
          await second.dispose().catch(() => undefined)
          await first.dispose().catch(() => undefined)
        }
      }
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('corrupt source fails without artifacts or source mutation', options, async () => {
  const root = mkdtempSync(join(tmpdir(), 'office corrupt reopen integration '))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  const sourcePath = join(root, 'broken.xlsx')
  writeFileSync(sourcePath, 'not a zip')
  const original = readFileSync(sourcePath)
  const session = createSession(root)
  const service = createOfficeService()
  try {
    const opened = await service.open({
      sessionId: session.sessionId,
      projectId: null,
      sourcePath,
      allowRoots: [root]
    })
    assert.equal(opened.state, 'error')
    if (opened.state !== 'error') throw new Error('corrupt source unexpectedly opened')
    assert.equal(opened.code, 'inspection_failed')
    assert.deepEqual(readFileSync(sourcePath), original)
    assert.deepEqual(artifactDirectories(session.dir), [])
  } finally {
    await service.dispose().catch(() => undefined)
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})
