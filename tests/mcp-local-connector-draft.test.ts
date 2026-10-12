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
  assert.throws(() => buildLocalConnectorRequest(draft({ name: 'x' })), /连接器名称需为 2–64 位/)
  assert.throws(
    () => buildLocalConnectorRequest(draft({ runtime: { kind: 'environment', ref: 'python@1' } })),
    /请选择已就绪的 Phi 运行环境/
  )
  assert.throws(
    () => buildLocalConnectorRequest(draft({ command: './server' })),
    /环境中的命令需为不含路径的命令名/
  )
  assert.throws(
    () =>
      buildLocalConnectorRequest(draft({ runtime: { kind: 'host' }, command: 'relative/server' })),
    /本机命令需使用绝对路径/
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
    /不能设置保留变量 PATH/
  )
  for (const name of ['LANG', 'TMPDIR']) {
    assert.throws(
      () =>
        buildLocalConnectorRequest(draft({ envRows: [{ id: 'row-1', name, value: 'override' }] })),
      new RegExp(`不能设置保留变量 ${name}`)
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
    /环境变量 MODE 重复/
  )
  assert.throws(
    () => buildLocalConnectorRequest(draft({ cwd: 'relative/path' })),
    /工作目录需使用绝对路径/
  )
  assert.throws(
    () => buildLocalConnectorRequest(draft({ argsText: Array(65).fill('arg').join('\n') })),
    /参数最多可填写 64 项/
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
        { ref: 'bun', label: 'Phi 内置 Bun', kind: 'bun' }
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
    [{ ref: 'bun', label: 'Phi 内置 Bun', kind: 'bun' }]
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
