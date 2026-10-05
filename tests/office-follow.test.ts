import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { OfficeFollowToggle } from '../src/renderer/src/features/office/components/OfficeFollowToggle'
import { OfficeReadyDocument } from '../src/renderer/src/features/office/components/OfficeReadyDocument'
import {
  OFFICE_FOLLOW_AI_STORAGE_KEY,
  readOfficeFollowAiPreference,
  writeOfficeFollowAiPreference
} from '../src/renderer/src/features/office/lib/officeFollowPreference'

test('follow AI defaults to enabled and persists explicit choices', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    }
  }

  assert.equal(readOfficeFollowAiPreference(storage), true)
  assert.equal(writeOfficeFollowAiPreference(storage, false), true)
  assert.equal(values.get(OFFICE_FOLLOW_AI_STORAGE_KEY), 'false')
  assert.equal(readOfficeFollowAiPreference(storage), false)
  assert.equal(writeOfficeFollowAiPreference(storage, true), true)
  assert.equal(readOfficeFollowAiPreference(storage), true)
})

test('follow AI storage failures and malformed values fall back safely', () => {
  assert.equal(
    readOfficeFollowAiPreference({
      getItem: () => {
        throw new Error('denied')
      }
    }),
    true
  )
  assert.equal(readOfficeFollowAiPreference({ getItem: () => 'maybe' }), true)
  assert.equal(
    writeOfficeFollowAiPreference(
      {
        setItem: () => {
          throw new Error('quota')
        }
      },
      false
    ),
    false
  )
})

test('follow AI toggle is accessible and reflects the current preference', () => {
  const enabled = renderToStaticMarkup(
    createElement(OfficeFollowToggle, { enabled: true, onChange: () => undefined })
  )
  const disabled = renderToStaticMarkup(
    createElement(OfficeFollowToggle, { enabled: false, onChange: () => undefined })
  )

  assert.match(enabled, /data-phi-office-follow-toggle="true"/u)
  assert.match(enabled, /aria-label="跟随 AI"/u)
  assert.match(enabled, /<input[^>]*checked/u)
  assert.match(disabled, /data-phi-office-follow-toggle="true"/u)
  assert.doesNotMatch(disabled, /<input[^>]*checked/u)
})

test('only a controllable XLSX document renders the follow AI toggle', () => {
  const render = (kind: 'xlsx' | 'docx' | 'pptx', controllable: boolean): string =>
    renderToStaticMarkup(
      createElement(OfficeReadyDocument, {
        document: {
          artifactId: `artifact-${kind}`,
          sessionId: 'session-1',
          projectId: null,
          kind,
          ...(controllable ? { followAiControllable: true as const } : {}),
          sourcePath: `/project/file.${kind}`,
          sourceHash: null,
          previewUrl: 'http://127.0.0.1:42001/',
          readOnly: false,
          saveState: 'saved' as const,
          lastSavedRevision: 0
        },
        save: { state: { phase: 'idle' as const }, save: async () => undefined },
        saveAs: {
          state: { phase: 'idle' as const },
          saveAs: async () => undefined,
          revealOutput: async () => undefined
        },
        reconciliation: { state: { phase: 'idle' as const }, reconcile: async () => undefined },
        humanEdit: { dismiss: () => undefined },
        followAi: { controllable, enabled: true, setEnabled: () => undefined },
        recreateFromSource: () => undefined
      })
    )

  assert.match(render('xlsx', true), /data-phi-office-follow-toggle="true"/u)
  assert.doesNotMatch(render('xlsx', false), /data-phi-office-follow-toggle/u)
  assert.doesNotMatch(render('docx', true), /data-phi-office-follow-toggle/u)
  assert.doesNotMatch(render('pptx', true), /data-phi-office-follow-toggle/u)
})
