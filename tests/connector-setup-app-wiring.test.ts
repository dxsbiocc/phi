import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('App opens a fresh unsent chat draft for connector setup guidance', () => {
  const source = readFileSync('src/renderer/src/App.tsx', 'utf8')
  assert.match(source, /onOpenConnectorSetupAgent/)
  assert.match(source, /rendererApi\.createSession\(\)/)
  assert.match(source, /updateSessionDraft\([\s\S]*?prompt/)
  assert.match(source, /onOpenSetupAgent=\{onOpenConnectorSetupAgent\}/)
  assert.doesNotMatch(source, /onOpenConnectorSetupAgent[\s\S]{0,900}sendPrompt\(/)
})

test('App routes a requested setup command to the terminal as an exact paste request', () => {
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  const terminal = readFileSync('src/renderer/src/features/terminal/TerminalPanel.tsx', 'utf8')
  assert.match(app, /onOpenConnectorSetupTerminal/)
  assert.match(app, /openWorkspaceSidePanel\('terminal'\)/)
  assert.match(app, /requestedInput=\{requestedTerminalInput\}/)
  assert.match(terminal, /submitPaste\(activeId, requestedInput\.text\)/)
  assert.match(terminal, /requestedInput\.text[\s\S]*?activeView\.focus\(\)/)
  assert.doesNotMatch(terminal, /requestedInput\.text\s*\+\s*['"]\\n/)
})
