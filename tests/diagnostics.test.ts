import assert from 'node:assert/strict'
import test from 'node:test'

import { formatDiagnostics, type DiagnosticsSnapshot } from '../src/main/agent/diagnostics'

test('formatDiagnostics redacts secrets from provider status and recent errors', () => {
  const text = formatDiagnostics({
    generatedAt: '2026-09-06T00:00:00.000Z',
    app: { name: 'Phi', version: '1.0.0' },
    platform: { os: 'darwin', node: 'v1', electron: 'e1' },
    currentSession: {
      path: null,
      cwd: '/project',
      permissionMode: 'auto'
    },
    model: {
      selected: { providerId: 'openai', modelId: 'gpt-test' },
      thinkingLevel: 'high',
      availableCount: 1
    },
    providers: [
      {
        providerId: 'openai',
        name: 'OpenAI',
        configured: true,
        source: 'stored',
        hasApiKey: true,
        hasOAuth: false,
        hasConfigError: false,
        statusText: 'failed with api_key=sk-live-secret12345'
      }
    ],
    projects: [
      {
        id: 'project-token: plain-secret',
        name: 'Project api_key=sk-live-secret12345',
        workingDirectory: '/tmp/Bearer abcdefghijklmnop',
        pathAvailable: true,
        permissionMode: 'ask'
      }
    ],
    sessions: [
      {
        path: '/sessions/token: plain-secret',
        status: 'failed'
      }
    ],
    skills: [
      {
        id: 'safe',
        name: 'Safe Skill',
        description: '',
        filePath: '/skills/safe/SKILL.md',
        source: 'user',
        scope: 'user',
        disabled: false
      },
      {
        id: 'disabled',
        name: 'Disabled token: plain-secret',
        description: '',
        filePath: '/skills/disabled/SKILL.md',
        source: 'user',
        scope: 'user',
        disabled: true
      }
    ],
    mcpServers: [
      {
        id: 'mcp',
        name: 'mcp api_key=sk-live-secret12345',
        command: 'server',
        status: 'configured'
      }
    ],
    plugins: [
      {
        id: 'plugin',
        name: 'Installed Bearer abcdefghijklmnop',
        source: 'npm:plugin',
        installed: true
      }
    ],
    activeRunCount: 0,
    logs: {
      directory: '/Users/test/.phi/logs',
      retentionDays: 14
    },
    recentErrors: ['upstream rejected Bearer abcdefghijklmnop and token: plain-secret']
  } satisfies DiagnosticsSnapshot)

  assert.match(text, /Log directory: \/Users\/test\/\.phi\/logs/)
  assert.match(text, /Log retention days: 14/)
  assert.match(text, /Disabled skills: 1/)
  assert.match(text, /Project api_key=\[redacted\]/)
  assert.match(text, /path=\/tmp\/Bearer \[redacted\]/)
  assert.match(text, /\/sessions\/token: \[redacted\]/)
  assert.match(text, /Disabled skill names: Disabled token: \[redacted\]/)
  assert.match(text, /MCP server names: mcp api_key=\[redacted\]/)
  assert.match(text, /Installed plugin names: Installed Bearer \[redacted\]/)
  assert.match(text, /api_key=\[redacted\]/)
  assert.match(text, /Bearer \[redacted\]/)
  assert.match(text, /token: \[redacted\]/)
  assert.doesNotMatch(text, /sk-live/)
  assert.doesNotMatch(text, /abcdefghijklmnop/)
  assert.doesNotMatch(text, /plain-secret/)
})
