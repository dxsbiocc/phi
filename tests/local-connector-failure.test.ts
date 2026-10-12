import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyLocalConnectorFailure } from '../src/main/agent/mcp/local-connector-failure'

const needsSetup = [
  'Configuration file not found: /x/qq-email-mcp.toml',
  'Missing API key',
  'token is not set',
  'Required environment variable QQ_EMAIL_AUTH is missing',
  'Run `foo init` first',
  "ENOENT: no such file or directory, open '/tmp/service.env'",
  'authentication required',
  'Please log in before starting the server'
]

for (const detail of needsSetup) {
  test(`classifies setup guidance from stderr: ${detail}`, () => {
    assert.deepEqual(
      classifyLocalConnectorFailure({
        error: 'MCP subprocess closed stdout before responding',
        detail
      }),
      { kind: 'needs-setup', reason: detail }
    )
  })
}

test('classification reads stderr detail only', () => {
  assert.deepEqual(
    classifyLocalConnectorFailure({ error: 'Configuration file not found: /x/config.toml' }),
    { kind: 'generic' }
  )
})

test('unrelated crashes remain generic', () => {
  for (const detail of [
    'Error: unexpected crash\n    at start (/tmp/server.js:1:1)',
    "4 | process.stderr.write('Configuration file not found: /tmp/x.toml')\n" +
      "7 | throw new Error('uncaught failure')\n" +
      '    ^\nerror: uncaught failure\n    at /tmp/needs-setup/fixture.js:7:1',
    "Error: Cannot find module 'missing-package'",
    'Segmentation fault: 11',
    'listen EADDRINUSE: address already in use 127.0.0.1:3000',
    ''
  ]) {
    assert.deepEqual(classifyLocalConnectorFailure({ detail }), { kind: 'generic' })
  }
})

test('stack frames that merely mention run/config/auth paths stay generic', () => {
  for (const detail of [
    'TypeError: x is not a function\n    at run (/app/dist/config/loader.js:10:5)\n    at main (/app/dist/index.js:3:1)',
    'Error: boom\n    at Object.run (/app/node_modules/foo/setup.js:22:11)',
    'Error: boom\n    at async init (file:///app/dist/auth/login.js:4:9)',
    'run@/app/dist/config.js:3:7\nmain@/app/dist/index.js:1:1'
  ]) {
    assert.deepEqual(classifyLocalConnectorFailure({ detail }), { kind: 'generic' }, detail)
  }
  // A real message that follows a stack still counts.
  const mixed = classifyLocalConnectorFailure({
    detail:
      '    at run (/app/dist/config/loader.js:10:5)\nConfiguration file not found: /tmp/x.toml'
  })
  assert.equal(mixed.kind, 'needs-setup')
  assert.equal(mixed.reason, 'Configuration file not found: /tmp/x.toml')
})

test('returns the first matching trimmed stderr line capped at 200 characters', () => {
  const first = `Configuration file not found: /tmp/${'x'.repeat(300)}.toml`
  const result = classifyLocalConnectorFailure({
    detail: `ordinary output\n  ${first}  \nAPI key is missing`
  })
  assert.equal(result.kind, 'needs-setup')
  assert.equal(result.reason, first.slice(0, 200))
  assert.equal(result.reason?.length, 200)
})
