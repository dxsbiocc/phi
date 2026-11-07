import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { WorkspaceResourceTabs } from '../src/renderer/src/components/WorkspaceResourceTabs'
import { subagentSessionTab } from '../src/renderer/src/features/workspace/lib/subagentTabs'
import {
  activeTabKeyAfterPrompt,
  upsertWorkspaceResourceTab
} from '../src/renderer/src/lib/workspaceResourceTabs'
import type { AgentExecutionItem } from '../src/renderer/src/lib/agentExecutionTypes'

const item: AgentExecutionItem = {
  id: 'tool-1',
  role: 'agent_execution',
  agentName: 'Reviewer',
  task: 'Inspect file',
  argsJson: '{}',
  argsPreview: '',
  status: 'running',
  steps: []
}
const parent = { stateKey: 'phi:a', sessionPath: '/a.jsonl', cwd: '/project' }

test('both child-run entry points reuse one tab even when runtime IDs arrive later', () => {
  const first = subagentSessionTab(item, parent)
  const updated = subagentSessionTab({ ...item, agentRunId: 'run-1', status: 'done' }, parent)
  const tabs = upsertWorkspaceResourceTab(upsertWorkspaceResourceTab([], first), updated)
  assert.equal(tabs.length, 1)
  assert.equal(first.key, updated.key)
  assert.equal(tabs[0].kind, 'subagent')
  assert.equal(activeTabKeyAfterPrompt(first.key, 'session:parent'), first.key)
})

test('same tool-call and run IDs in different parents cannot share a temporary conversation', () => {
  const a = subagentSessionTab(item, parent)
  const b = subagentSessionTab(item, { ...parent, stateKey: 'phi:b' })
  assert.notEqual(a.key, b.key)
  assert.equal(upsertWorkspaceResourceTab([a], b).length, 2)
  assert.equal(a.parentSessionPath, parent.sessionPath)
  assert.equal(a.cwd, parent.cwd)
})

test('remote temporary conversations keep their original file scope and server cwd', () => {
  const remoteFiles = {
    sessionId: 'phi-remote',
    projectId: 'remote-project',
    hostAlias: 'lab',
    remoteRoot: '/data',
    canonicalRoot: '/data'
  }
  const tab = subagentSessionTab(item, { ...parent, cwd: '/data/analysis', remoteFiles })
  assert.equal(tab.remoteFiles, remoteFiles)
  assert.equal(tab.cwd, '/data/analysis')
})

test('a General run tab shows its avatar and symbol while retaining the English accessible name', () => {
  const gammaTab = subagentSessionTab({ ...item, agentName: 'Gamma' }, parent)
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(WorkspaceResourceTabs, {
        tabs: [gammaTab],
        activeKey: gammaTab.key,
        onSelect: () => undefined,
        onClose: () => undefined
      })
    )
  )

  assert.match(markup, /title="Gamma"/)
  assert.match(markup, /aria-label="Gamma"/)
  assert.match(markup, /alt="Gamma"/)
  assert.match(markup, />γ</)
})
