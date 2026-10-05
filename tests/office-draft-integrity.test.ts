import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  checkRegisteredOfficeDraftIntegrity,
  OfficeDraftIntegrityError
} from '../src/main/agent/office/office-draft-integrity'
import {
  loadOfficeOperationLog,
  persistOfficeOperationLog
} from '../src/main/agent/office/office-operation-log'
import { createPhiSession } from '../src/main/agent/session/session-store'
import { MAX_OFFICE_FILE_BYTES, type OfficeArtifact } from '../src/main/agent/office/office-files'

interface RegisteredDraftFixture {
  readonly root: string
  readonly sessionId: string
  readonly artifactDir: string
  readonly draftPath: string
  readonly artifact: OfficeArtifact
  readonly cleanup: () => void
}

function setupRegisteredDraft(origin: 'source' | 'blank' = 'source'): RegisteredDraftFixture {
  const root = mkdtempSync(join(tmpdir(), 'office-draft-integrity-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  const session = createPhiSession({
    kind: 'ordinary',
    cwd: root,
    cwdRealPath: root,
    permissionMode: 'auto'
  })
  const artifactDir = join(session.dir, 'artifacts', 'office', 'artifact-1')
  const draftPath = join(artifactDir, 'book.xlsx')
  mkdirSync(artifactDir, { recursive: true })
  copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx'), draftPath)
  const artifact =
    origin === 'blank'
      ? {
          artifactId: 'artifact-1',
          sessionId: session.sessionId,
          projectId: null,
          origin: 'blank' as const,
          sourcePath: null,
          sourceHash: null,
          draftPath
        }
      : {
          artifactId: 'artifact-1',
          sessionId: session.sessionId,
          projectId: null,
          sourcePath: join(root, 'book.xlsx'),
          sourceHash: 'a'.repeat(64),
          draftPath
        }
  writeFileSync(join(artifactDir, 'artifact.json'), JSON.stringify(artifact))
  const cleanup = (): void => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
  return { root, sessionId: session.sessionId, artifactDir, draftPath, artifact, cleanup }
}

test('accepts a saved registered draft when its file hash matches the confirmed hash', async () => {
  const fixture = setupRegisteredDraft()
  try {
    const savedDraftHash = createHash('sha256')
      .update(readFileSync(fixture.draftPath))
      .digest('hex')
    await persistOfficeOperationLog(fixture.draftPath, {
      version: 2,
      contentRevision: 2,
      operations: {},
      saveState: 'saved',
      lastSavedRevision: 2,
      savedDraftHash
    })

    const result = await checkRegisteredOfficeDraftIntegrity(fixture.artifact, fixture.sessionId)

    assert.equal(result.issue, undefined)
    assert.equal(result.operationLog.contentRevision, 2)
    assert.equal(result.operationLog.freezeState, undefined)
  } finally {
    fixture.cleanup()
  }
})

test('freezes a saved draft when its bytes differ from the confirmed hash', async () => {
  const fixture = setupRegisteredDraft()
  try {
    await persistOfficeOperationLog(fixture.draftPath, {
      version: 2,
      contentRevision: 3,
      operations: {},
      saveState: 'saved',
      lastSavedRevision: 3,
      savedDraftHash: 'b'.repeat(64)
    })

    const result = await checkRegisteredOfficeDraftIntegrity(fixture.artifact, fixture.sessionId)

    assert.equal(result.issue, 'draft_hash_mismatch')
    assert.equal(result.operationLog.freezeState, 'unknown')
    assert.equal(result.operationLog.needsSave, true)
    assert.match(result.operationLog.lastReconcile?.reason ?? '', /最后一次确认保存/)
    assert.equal((await loadOfficeOperationLog(fixture.draftPath)).freezeState, 'unknown')
  } finally {
    fixture.cleanup()
  }
})

test('accepts a close-time repack only when the pre-close hash was confirmed and no write is in flight', async () => {
  const fixture = setupRegisteredDraft()
  try {
    const confirmedHash = 'b'.repeat(64)
    await persistOfficeOperationLog(fixture.draftPath, {
      version: 2,
      contentRevision: 3,
      operations: {},
      saveState: 'saved',
      lastSavedRevision: 3,
      savedDraftHash: confirmedHash
    })

    const result = await checkRegisteredOfficeDraftIntegrity(fixture.artifact, fixture.sessionId, {
      confirmedHashBeforeClose: confirmedHash
    })

    assert.equal(result.issue, undefined)
    assert.equal(result.operationLog.freezeState, undefined)
    assert.notEqual(result.operationLog.savedDraftHash, confirmedHash)
    assert.equal(
      (await loadOfficeOperationLog(fixture.draftPath)).savedDraftHash,
      result.operationLog.savedDraftHash
    )
  } finally {
    fixture.cleanup()
  }
})

test('reports missing and corrupt drafts without changing their registered source', async () => {
  for (const scenario of ['missing', 'corrupt'] as const) {
    const fixture = setupRegisteredDraft()
    try {
      if (scenario === 'missing') unlinkSync(fixture.draftPath)
      else writeFileSync(fixture.draftPath, 'not a zip')
      await assert.rejects(
        checkRegisteredOfficeDraftIntegrity(fixture.artifact, fixture.sessionId),
        (error: unknown) => {
          assert.ok(error instanceof OfficeDraftIntegrityError)
          assert.equal(error.code, scenario === 'missing' ? 'draft_missing' : 'draft_corrupt')
          assert.equal(error.canRecreateFromSource, true)
          return true
        }
      )
      assert.equal(existsSync(join(fixture.artifactDir, 'artifact.json')), true)
    } finally {
      fixture.cleanup()
    }
  }
})

test('rejects a registered draft expanded beyond the shared 25 MiB limit', async () => {
  const fixture = setupRegisteredDraft()
  try {
    const draftPath = join(fixture.artifactDir, 'book.docx')
    renameSync(fixture.draftPath, draftPath)
    const artifact: OfficeArtifact = {
      ...fixture.artifact,
      kind: 'docx',
      sourcePath: join(fixture.root, 'book.docx'),
      draftPath
    }
    writeFileSync(join(fixture.artifactDir, 'artifact.json'), JSON.stringify(artifact))
    truncateSync(draftPath, MAX_OFFICE_FILE_BYTES + 1)

    await assert.rejects(
      checkRegisteredOfficeDraftIntegrity(artifact, fixture.sessionId),
      (error: unknown) => {
        assert.ok(error instanceof OfficeDraftIntegrityError)
        assert.equal(error.code, 'draft_too_large')
        assert.equal(error.canRecreateFromSource, true)
        assert.match(error.message, /25 MB/u)
        return true
      }
    )
  } finally {
    fixture.cleanup()
  }
})

test('does not offer source recreation for a missing blank draft', async () => {
  const fixture = setupRegisteredDraft('blank')
  try {
    unlinkSync(fixture.draftPath)
    await assert.rejects(
      checkRegisteredOfficeDraftIntegrity(fixture.artifact, fixture.sessionId),
      (error: unknown) => {
        assert.ok(error instanceof OfficeDraftIntegrityError)
        assert.equal(error.code, 'draft_missing')
        assert.equal(error.canRecreateFromSource, false)
        return true
      }
    )
  } finally {
    fixture.cleanup()
  }
})

test('rejects registration identity changes and draft symlinks', async () => {
  const fixture = setupRegisteredDraft()
  try {
    writeFileSync(
      join(fixture.artifactDir, 'artifact.json'),
      JSON.stringify({ ...fixture.artifact, sessionId: 'other-session' })
    )
    await assert.rejects(
      checkRegisteredOfficeDraftIntegrity(fixture.artifact, fixture.sessionId),
      (error: unknown) =>
        error instanceof OfficeDraftIntegrityError && error.code === 'draft_identity_mismatch'
    )
    writeFileSync(join(fixture.artifactDir, 'artifact.json'), JSON.stringify(fixture.artifact))
    const realDraft = join(fixture.root, 'outside.xlsx')
    copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx'), realDraft)
    unlinkSync(fixture.draftPath)
    symlinkSync(realDraft, fixture.draftPath)
    await assert.rejects(
      checkRegisteredOfficeDraftIntegrity(fixture.artifact, fixture.sessionId),
      (error: unknown) => (error as { code?: unknown }).code === 'draft_symlink'
    )
  } finally {
    fixture.cleanup()
  }
})

test('backs up a corrupt operations log and returns a frozen fail-closed state', async () => {
  const fixture = setupRegisteredDraft()
  try {
    writeFileSync(join(fixture.artifactDir, 'operations.json'), '{broken')

    const result = await checkRegisteredOfficeDraftIntegrity(fixture.artifact, fixture.sessionId)

    assert.equal(result.issue, 'operation_log_corrupt')
    assert.equal(result.operationLog.freezeState, 'unknown')
    assert.equal(result.operationLog.integrityError, 'operation_log_corrupt')
    assert.ok(
      readdirSync(fixture.artifactDir).some((name) => name.startsWith('operations.json.corrupt-'))
    )
  } finally {
    fixture.cleanup()
  }
})
