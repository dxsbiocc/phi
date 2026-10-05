import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  markOfficeEditing,
  markOfficeSaveFailed,
  markOfficeSaving,
  markOfficeSaved,
  markOfficeUnsaved,
  restoreOfficeSaveStatus
} from '../src/main/agent/office/office-save-state'

test('a persisted draft moves from saved to editing and back to the saved revision', () => {
  const restored = restoreOfficeSaveStatus({ contentRevision: 0, needsSave: false })

  assert.deepEqual(restored, {
    saveState: 'saved',
    lastSavedRevision: 0
  })
  assert.deepEqual(markOfficeEditing(restored), {
    saveState: 'editing',
    lastSavedRevision: 0
  })
  assert.deepEqual(
    markOfficeSaved(markOfficeEditing(restored), {
      revision: 1,
      savedAt: '2026-10-05T12:00:00.000Z',
      sha256: 'a'.repeat(64)
    }),
    {
      saveState: 'saved',
      lastSavedRevision: 1,
      lastSavedAt: '2026-10-05T12:00:00.000Z',
      savedDraftHash: 'a'.repeat(64)
    }
  )
})

test('a failed write save remains retryable and an explicit retry becomes saved', () => {
  const editing = markOfficeEditing(
    restoreOfficeSaveStatus({ contentRevision: 2, needsSave: false })
  )
  const unsaved = markOfficeUnsaved(editing)

  assert.equal(unsaved.saveState, 'unsaved')
  assert.equal(unsaved.lastSavedRevision, 2)

  const failed = markOfficeSaveFailed(markOfficeSaving(unsaved))
  assert.equal(failed.saveState, 'failed')
  assert.equal(failed.lastSavedRevision, 2)

  const retried = markOfficeSaved(markOfficeSaving(failed), {
    revision: 3,
    savedAt: '2026-10-05T12:01:00.000Z',
    sha256: 'b'.repeat(64)
  })
  assert.equal(retried.saveState, 'saved')
  assert.equal(retried.lastSavedRevision, 3)
})

test('a frozen persisted document never restores as saved', () => {
  const restored = restoreOfficeSaveStatus({
    contentRevision: 2,
    needsSave: false,
    frozen: true,
    persisted: {
      saveState: 'saved',
      lastSavedRevision: 2,
      lastSavedAt: '2026-10-05T12:00:00.000Z',
      savedDraftHash: 'c'.repeat(64)
    }
  })
  assert.equal(restored.saveState, 'unsaved')
  assert.equal(restored.lastSavedRevision, 2)
})

test('a persisted explicit save failure restores as failed and remains retryable', () => {
  const restored = restoreOfficeSaveStatus({
    contentRevision: 3,
    needsSave: true,
    persisted: { saveState: 'failed', lastSavedRevision: 2 }
  })
  assert.equal(restored.saveState, 'failed')
  assert.equal(restored.lastSavedRevision, 2)
})
