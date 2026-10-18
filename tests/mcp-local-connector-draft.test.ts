import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLocalConnectorRequest,
  draftToFormState,
  formatLocalConnectorArgv,
  parseLocalConnectorArgs,
  type LocalConnectorDraft
} from '../src/renderer/src/features/mcp/lib/localConnectorDraft'

function draft(overrides: Partial<LocalConnectorDraft> = {}): LocalConnectorDraft {
  return {
    name: 'literature',
    runtime: { kind: 'environment', ref: 'phi:python@1' },
    command: 'uvx',
    argsText: '--from\nmcp-server\n\nvalue with spaces',
    envRows: [{ id: 'row-1', name: 'LOG_LEVEL', value: 'info' }],
    cwd: '/tmp',
    ...overrides
  }
}

test('local connector arguments are one argv item per non-blank line', () => {
  assert.deepEqual(parseLocalConnectorArgs('--flag\r\n\r\nvalue with spaces\n  \n --literal '), [
    '--flag',
    'value with spaces',
    ' --literal '
  ])
})

test('local connector draft produces the validated IPC request without shell parsing', () => {
  assert.deepEqual(buildLocalConnectorRequest(draft()), {
    name: 'literature',
    runtime: { kind: 'environment', ref: 'phi:python@1' },
    command: 'uvx',
    args: ['--from', 'mcp-server', 'value with spaces'],
    env: { LOG_LEVEL: 'info' },
    cwd: '/tmp'
  })
})

test('local connector draft mirrors command, runtime, argv, and environment validation', () => {
  assert.throws(
    () => buildLocalConnectorRequest(draft({ name: 'x' })),
    /Connector names must contain 2–64/
  )
  assert.throws(
    () => buildLocalConnectorRequest(draft({ runtime: { kind: 'environment', ref: 'python@1' } })),
    /Choose a ready Phi runtime/
  )
  assert.throws(
    () => buildLocalConnectorRequest(draft({ command: './server' })),
    /Environment commands must be command names without a path/
  )
  assert.throws(
    () =>
      buildLocalConnectorRequest(draft({ runtime: { kind: 'host' }, command: 'relative/server' })),
    /Host commands must use an absolute path/
  )
  for (const command of ['install', 'add', 'create', 'upgrade', 'pm', 'repl', 'exec']) {
    assert.throws(
      () => buildLocalConnectorRequest(draft({ runtime: { kind: 'bun' }, command })),
      /Bun.*x.*run|x.*run/
    )
  }
  assert.equal(
    buildLocalConnectorRequest(draft({ runtime: { kind: 'bun' }, command: 'run' })).command,
    'run'
  )
  assert.throws(
    () =>
      buildLocalConnectorRequest(
        draft({ envRows: [{ id: 'row-1', name: 'PATH', value: '/unsafe' }] })
      ),
    /Cannot set reserved variable PATH/
  )
  for (const name of ['LANG', 'TMPDIR']) {
    assert.throws(
      () =>
        buildLocalConnectorRequest(draft({ envRows: [{ id: 'row-1', name, value: 'override' }] })),
      new RegExp(`Cannot set reserved variable ${name}`)
    )
  }
  assert.throws(
    () =>
      buildLocalConnectorRequest(
        draft({
          envRows: [
            { id: 'row-1', name: 'MODE', value: 'one' },
            { id: 'row-2', name: 'MODE', value: 'two' }
          ]
        })
      ),
    /Duplicate environment variable MODE/
  )
  assert.throws(
    () => buildLocalConnectorRequest(draft({ cwd: 'relative/path' })),
    /Working directory must use an absolute path/
  )
  assert.throws(
    () => buildLocalConnectorRequest(draft({ argsText: Array(65).fill('arg').join('\n') })),
    /Use at most 64 arguments/
  )
})

test('host draft preserves an absolute executable path and omits an empty cwd', () => {
  assert.deepEqual(
    buildLocalConnectorRequest(
      draft({
        runtime: { kind: 'host' },
        command: '/usr/local/bin/mcp-server',
        argsText: '--stdio',
        cwd: ''
      })
    ),
    {
      name: 'literature',
      runtime: { kind: 'host' },
      command: '/usr/local/bin/mcp-server',
      args: ['--stdio'],
      env: { LOG_LEVEL: 'info' }
    }
  )
})

test('argv preview shell-quotes each exact argument without joining or reparsing it', () => {
  assert.equal(
    formatLocalConnectorArgv('/opt/My Server/bin/mcp', [
      '--title',
      "O'Reilly",
      'value with spaces'
    ]),
    `'/opt/My Server/bin/mcp' --title 'O'"'"'Reilly' 'value with spaces'`
  )
})

test('GitHub local draft prefills exact argv and selects Phi built-in Bun when available', () => {
  assert.deepEqual(
    draftToFormState(
      {
        tab: 'local',
        name: 'qq-email-mcp',
        runtimeHint: 'bun',
        command: 'x',
        args: ['--bun', 'qq-email-mcp@0.1.1']
      },
      [
        { ref: 'phi:r@1', label: 'R' },
        { ref: 'bun', label: 'Phi bundled Bun', kind: 'bun' }
      ]
    ),
    {
      name: 'qq-email-mcp',
      runtime: { kind: 'bun' },
      command: 'x',
      argsText: '--bun\nqq-email-mcp@0.1.1',
      envRows: [],
      cwd: ''
    }
  )
})

test('GitHub setup hints survive draft conversion and request building unchanged', () => {
  const setup = {
    readmeUrl: 'https://github.com/xieningqing/qq-email-mcp/blob/abc/README.md',
    commands: ['npx -y qq-email-mcp init']
  }
  const state = draftToFormState(
    {
      tab: 'local',
      name: 'qq-email-mcp',
      runtimeHint: 'bun',
      command: 'x',
      args: ['--bun', 'qq-email-mcp@0.1.1'],
      setup
    },
    [{ ref: 'bun', label: 'Phi bundled Bun', kind: 'bun' }]
  )
  assert.deepEqual(state.hint, {
    readmeUrl: setup.readmeUrl,
    setupCommands: setup.commands
  })
  assert.deepEqual(buildLocalConnectorRequest(state).hint, state.hint)
})

test('GitHub Bun draft stays prefilled but unselected when built-in Bun is unavailable', () => {
  const state = draftToFormState(
    {
      tab: 'local',
      name: 'qq-email-mcp',
      runtimeHint: 'bun',
      command: 'x',
      args: ['--bun', 'qq-email-mcp@0.1.1']
    },
    [{ ref: 'phi:r@1', label: 'R' }]
  )
  assert.deepEqual(state.runtime, { kind: 'environment', ref: '' })
  assert.equal(state.command, 'x')
  assert.equal(state.argsText, '--bun\nqq-email-mcp@0.1.1')
})
