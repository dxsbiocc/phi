import assert from 'node:assert/strict'
import test from 'node:test'

import { workspaceViewModeFor } from '../src/renderer/src/features/workspace/lib/workspaceViewMode'

const base = {
  showWorkspaceTabs: false,
  isAnalysisWorkspaceView: false,
  analysisFilePreviewAvailable: false,
  chatSelected: true,
  visibleTabCount: 0
}

test('open workspace tabs own the column above every other surface', () => {
  assert.equal(
    workspaceViewModeFor({
      ...base,
      showWorkspaceTabs: true,
      isAnalysisWorkspaceView: true,
      analysisFilePreviewAvailable: true,
      visibleTabCount: 2
    }),
    'tabs'
  )
})

test('the analysis view shows a file preview when one is selected', () => {
  assert.equal(
    workspaceViewModeFor({
      ...base,
      isAnalysisWorkspaceView: true,
      analysisFilePreviewAvailable: true,
      chatSelected: false
    }),
    'file-preview'
  )
})

test('the analysis view falls back to the canvas without a file preview', () => {
  assert.equal(
    workspaceViewModeFor({ ...base, isAnalysisWorkspaceView: true, chatSelected: false }),
    'analysis'
  )
})

test('an empty chat view shows the placement screen', () => {
  assert.equal(workspaceViewModeFor(base), 'chat-empty')
  assert.equal(workspaceViewModeFor({ ...base, visibleTabCount: 1 }), 'chat')
})

test('a project session placeholder keeps the chat surface', () => {
  assert.equal(workspaceViewModeFor({ ...base, chatSelected: false }), 'chat')
})
