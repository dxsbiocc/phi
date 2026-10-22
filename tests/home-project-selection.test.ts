import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { applyHomeProjectSelection } from '../src/renderer/src/features/home/hooks/useHomePrompt'

test('a new home selection chooses or clears the project', () => {
  const initial = { projectId: 'kept', appliedKey: 1 }
  assert.equal(applyHomeProjectSelection(initial, null), initial)
  assert.equal(applyHomeProjectSelection(initial, { key: 1, projectId: 'other' }), initial)

  assert.deepEqual(applyHomeProjectSelection(initial, { key: 2, projectId: 'project-a' }), {
    projectId: 'project-a',
    appliedKey: 2
  })
  assert.deepEqual(applyHomeProjectSelection(initial, { key: 3, projectId: null }), {
    projectId: null,
    appliedKey: 3
  })
})

test('new conversation buttons open the home page instead of creating a session', () => {
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  assert.match(
    app,
    /const onNewChatFromSidebar = useCallback\(async \(\): Promise<void> => \{\s*openHomeForNewConversation\(null\)/
  )
  assert.match(
    app,
    /const onStartProjectChatFromSidebar = useCallback\(\s*async \(project: Project\): Promise<void> => \{\s*openHomeForNewConversation\(project\.id\)/
  )
  assert.match(app, /openHomeForNewConversation\(project\.id\)/)
  assert.match(app, /setSessionTabWasOpened\(false\)/)
  assert.match(app, /setActiveWorkspaceTabKey\(null\)/)
  assert.match(app, /navigateToView\('chat'\)/)
})
