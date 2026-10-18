import assert from 'node:assert/strict'
import test from 'node:test'

import { buildConnectorSetupPrompt } from '../src/renderer/src/features/mcp/lib/connectorSetupPrompt'
import type { McpConnectorSetupProgress } from '../src/shared/mcpConnectorCatalog'

function setup(overrides: Partial<McpConnectorSetupProgress> = {}): McpConnectorSetupProgress {
  return {
    id: 'qq-email-mcp',
    kind: 'local-stdio',
    title: 'QQ 邮箱',
    phase: 'failed',
    revision: 2,
    updatedAt: '2026-10-11T08:01:00.000Z',
    summary: 'bun x --bun qq-email-mcp@0.1.1',
    error: 'MCP subprocess closed stdout before responding',
    detail: '\u001b[31mConfiguration file not found: /tmp/qq.toml\u001b[0m\u0000',
    failureKind: 'needs-setup',
    failureReason: 'Configuration file not found: /tmp/qq.toml',
    setupHint: {
      readmeUrl: 'https://github.com/xieningqing/qq-email-mcp/blob/abc/README.md',
      commands: ['npx -y qq-email-mcp init']
    },
    ...overrides
  }
}

test('builds a bounded sanitized unsent-Agent setup prompt with secret guardrails', () => {
  const prompt = buildConnectorSetupPrompt(
    Object.assign(setup({ detail: `${setup().detail}\n${'x'.repeat(5_000)}` }), {
      env: { QQ_EMAIL_AUTH: 'super-secret-value' }
    })
  )
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= 8 * 1024)
  assert.match(prompt, /QQ 邮箱/)
  assert.match(prompt, /local-stdio/)
  assert.match(prompt, /bun x --bun qq-email-mcp@0\.1\.1/)
  assert.match(prompt, /Configuration file not found/)
  assert.match(prompt, /https:\/\/github\.com\/xieningqing\/qq-email-mcp/)
  assert.match(prompt, /npx -y qq-email-mcp init/)
  assert.match(prompt, /Do not ask me to paste secrets into chat/)
  assert.match(prompt, /for me to confirm and enter directly in the terminal/)
  assert.match(prompt, /return to Background tasks and select Retry/)
  assert.ok(!prompt.includes('\u001b'))
  assert.ok(!prompt.includes('\u0000'))
  assert.doesNotMatch(prompt, /super-secret-value/)
  assert.ok(prompt.split('x').length < 2_200, 'process output should be limited near 2 KiB')
})

test('uses the generic investigation wording when setup was not classified', () => {
  const prompt = buildConnectorSetupPrompt(
    setup({ failureKind: 'generic', failureReason: undefined, setupHint: undefined })
  )
  assert.match(prompt, /troubleshoot/)
  assert.match(prompt, /Do not.*secrets.*chat/)
})
