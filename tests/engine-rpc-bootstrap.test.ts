import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  loadRpcBootstrapConfig,
  validateRpcBootstrapConfig,
  RPC_BOOTSTRAP_COMMAND,
  RPC_BOOTSTRAP_DESCRIPTION,
  type RpcBootstrapConfig
} from '../src/main/agent/engine/phi-extension/lib/rpc-config'
import {
  attestBootstrap,
  createBootstrapAttester
} from '../src/main/agent/engine/rpc/bootstrap-attestation'
import type { RpcFrame } from '../src/main/agent/engine/rpc/types'
import { RpcSessionBackend } from '../src/main/agent/engine/rpc/rpc-session-backend'
import { createBootstrapFixture } from './engine-contract/bootstrap-stdio-fixture'
import { extensionPackageBoundary } from './helpers/extensionPackageBoundary'
import { HOST_PROVIDED_OMP_IMPORTS } from '../src/main/agent/engine/rpc/extension-deployment/bundle'

const packageRoot = fileURLToPath(
  new URL('../src/main/agent/engine/phi-extension', import.meta.url)
)

test('RPC extension package remains self-contained with type-only SDK root imports', () => {
  const [eventStream, internalUrls, agentLifecycle] = HOST_PROVIDED_OMP_IMPORTS
  const boundary = extensionPackageBoundary(packageRoot, HOST_PROVIDED_OMP_IMPORTS)
  assert.deepEqual(boundary.failures, [])
  assert.deepEqual(boundary.hostImports, [
    `extensions/rpc-child-control.ts -> ${agentLifecycle}`,
    `extensions/rpc-subagents.ts -> ${internalUrls}`,
    `lib/rpc-native-stream-adapter.ts -> ${eventStream}`,
    `rpc-entry.ts -> ${agentLifecycle}`
  ])
})

test('bootstrap config enforces private plain bounded identity and canonical project', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-bootstrap-config-')))
  try {
    const config: RpcBootstrapConfig = {
      schema: 1,
      sessionId: 'session',
      projectId: 'project',
      nonce: '0123456789abcdef',
      projectRoot: root,
      ompVersion: '18.10.3',
      contentHash: 'a'.repeat(64)
    }
    const path = join(root, 'config.json')
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
    assert.deepEqual(loadRpcBootstrapConfig(path), config)
    for (const invalid of [
      null,
      [],
      { ...config, schema: 2 },
      { ...config, secret: 'unexpected' },
      { ...config, ompVersion: '18.1.10' },
      { ...config, nonce: 'short' },
      { ...config, projectId: 'bad\nidentity' },
      { ...config, contentHash: 'A'.repeat(64) },
      { ...config, projectRoot: `${root}/.` },
      { ...config, projectRoot: 'relative' }
    ])
      assert.throws(() => validateRpcBootstrapConfig(invalid))
    assert.throws(() => loadRpcBootstrapConfig(undefined))
    chmodSync(path, 0o644)
    assert.throws(() => loadRpcBootstrapConfig(path), /private/)
    chmodSync(path, 0o600)
    const link = join(root, 'link.json')
    symlinkSync(path, link)
    assert.throws(() => loadRpcBootstrapConfig(link), /canonical/)
    writeFileSync(path, ' '.repeat(16 * 1024 + 1))
    assert.throws(() => loadRpcBootstrapConfig(path), /16 KiB/)
    writeFileSync(path, Buffer.from([0xff]))
    assert.throws(() => loadRpcBootstrapConfig(path))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  'real CLI loads the guarded default entry and attests without invoking a model',
  { timeout: 30000 },
  async (t) => {
    const f = await createBootstrapFixture()
    t.after(() => f.close())
    await f.connection.start().catch((error) => {
      throw new Error(`${String(error)}\n${f.stderr()}`)
    })
    const data = await f.connection.request<{
      commands: Array<{ name: string; source: string; description?: string }>
    }>({ type: 'get_available_commands' })
    assert.deepEqual(
      data.commands
        .filter((c) => c.name === RPC_BOOTSTRAP_COMMAND)
        .map((c) => ({ name: c.name, source: c.source, description: c.description })),
      [
        { name: RPC_BOOTSTRAP_COMMAND, source: 'extension', description: RPC_BOOTSTRAP_DESCRIPTION }
      ],
      f.stderr()
    )
    await attestBootstrap(f.connection, f.expected, new AbortController().signal)
    assert.equal(f.provider.requests.length, 0)
    assert.equal(
      f.frames.some((frame) => frame.type === 'agent_start'),
      false
    )
  }
)

test(
  'real managed backend becomes ready only after the extension attests',
  { timeout: 30000 },
  async (t) => {
    const f = await createBootstrapFixture()
    t.after(() => f.close())
    const backend = new RpcSessionBackend(f.open, {
      initialize: createBootstrapAttester(f.expected),
      startupTimeoutMs: 15000,
      requestTimeoutMs: 10000
    })
    t.after(() => backend.dispose({ sessionId: f.expected.sessionId }))
    const state = await backend.create({
      sessionId: f.expected.sessionId,
      cwd: f.cwd,
      agentDir: f.agentDir,
      model: {
        provider: 'phi-contract',
        id: 'contract-model',
        name: 'Contract Model',
        reasoning: false
      }
    })
    assert.equal(state.sessionId, f.expected.sessionId)
    assert.equal(backend.has(f.expected.sessionId), true)
    assert.equal(f.provider.requests.length, 0)
  }
)

for (const [label, options] of [
  ['missing config', { missingConfig: true }],
  ['malformed config', { config: () => ({ schema: 1 }) }],
  [
    'wrong version',
    { config: (valid: RpcBootstrapConfig) => ({ ...valid, ompVersion: '18.1.10' }) }
  ],
  [
    'wrong project',
    {
      config: (valid: RpcBootstrapConfig) => ({
        ...valid,
        projectRoot: join(valid.projectRoot, '..')
      })
    }
  ],
  ['public config', { configMode: 0o644 }],
  ['missing entry', { missingEntry: true }]
] as const) {
  test(
    `real CLI ${label} cannot bypass managed startup even if loader continues`,
    { timeout: 30000 },
    async (t) => {
      const f = await createBootstrapFixture(options)
      t.after(() => f.close())
      const backend = new RpcSessionBackend(f.open, {
        initialize: createBootstrapAttester(f.expected, { timeoutMs: 5000 }),
        startupTimeoutMs: 15000,
        requestTimeoutMs: 10000
      })
      t.after(() => backend.dispose({ sessionId: f.expected.sessionId }))
      await assert.rejects(
        backend.create({
          sessionId: f.expected.sessionId,
          cwd: f.cwd,
          agentDir: f.agentDir,
          model: {
            provider: 'phi-contract',
            id: 'contract-model',
            name: 'Contract Model',
            reasoning: false
          }
        }),
        /Phi RPC bootstrap guard command is not loaded/
      )
      assert.equal(backend.has(f.expected.sessionId), false)
      assert.equal(f.running(), false, 'Rejected initialization must reap the actual CLI process')
      await assert.rejects(
        backend.prompt({ sessionId: f.expected.sessionId, text: 'must not send' })
      )
      assert.equal(f.provider.requests.length, 0, f.stderr())
    }
  )
}

test(
  'real native tools allow explicit project text read and deny escape and execution without side effects',
  { timeout: 60000 },
  async (t) => {
    const f = await createBootstrapFixture()
    t.after(() => f.close())
    const allowed = join(f.cwd, 'allowed.txt')
    const outside = join(f.root, 'outside.txt')
    const link = join(f.cwd, 'escape.txt')
    const writeTarget = join(f.cwd, 'write-must-not-exist.txt')
    const shellTarget = join(f.cwd, 'shell-must-not-exist.txt')
    writeFileSync(allowed, 'PROJECT_VISIBLE_MARKER\n')
    writeFileSync(outside, 'OUTSIDE_PRIVATE_MARKER\n')
    writeFileSync(join(f.cwd, 'document.pdf'), 'converter-must-not-run')
    symlinkSync(outside, link)
    writeFileSync(join(f.cwd, 'collision.txt'), 'COLLISION_VISIBLE_MARKER')
    symlinkSync(outside, join(f.cwd, 'collision.txt:raw'))
    mkdirSync(join(f.cwd, 'nested'))
    await f.connection.start().catch((error) => {
      throw new Error(`${String(error)}\n${f.stderr()}`)
    })
    await attestBootstrap(f.connection, f.expected, new AbortController().signal)
    const execute = async (
      name: string,
      args: Record<string, unknown>,
      label: string
    ): Promise<RpcFrame> => {
      const offset = f.frames.length
      f.provider.enqueue({ tool: { name, args } }, { text: `completed ${label}` })
      await f.connection.prompt(`Execute fixture scenario ${label}`)
      const end = f.frames
        .slice(offset)
        .find((frame) => frame.type === 'tool_execution_end' && frame.toolName === name)
      assert.ok(end, `Missing ${name} result: ${f.stderr()}`)
      return end
    }
    const read = await execute('read', { path: 'allowed.txt' }, 'allowed')
    assert.equal(read.isError, false, JSON.stringify(read))
    assert.match(JSON.stringify(read.result), /PROJECT_VISIBLE_MARKER/)
    for (const [label, name, args] of [
      ['absolute outside', 'read', { path: outside }],
      ['relative outside', 'read', { path: '../outside.txt' }],
      ['symlink outside', 'read', { path: link }],
      ['SSH URL', 'read', { path: 'ssh://fixture/outside.txt' }],
      ['HTTP URL', 'read', { path: `${f.provider.url}/secret` }],
      ['file URI', 'read', { path: `file://${outside}` }],
      ['internal URI', 'read', { path: 'session://current' }],
      ['literal raw collision', 'read', { path: 'collision.txt' }],
      ['converter', 'read', { path: 'document.pdf' }],
      ['directory', 'read', { path: 'nested' }],
      ['selector', 'read', { path: 'allowed.txt:1' }],
      ['mixed path list', 'read', { path: `allowed.txt;${outside}` }],
      ['fuzzy missing path', 'read', { path: 'nested/allowed.txt' }],
      ['native write', 'write', { path: writeTarget, content: 'BAD_WRITE' }],
      [
        'native edit',
        'edit',
        { path: allowed, old_string: 'PROJECT_VISIBLE_MARKER', new_string: 'BAD_EDIT' }
      ],
      ['native shell', 'bash', { command: `printf BAD_EXEC > '${shellTarget}'` }],
      ['unbridged glob', 'glob', { path: '**/*' }]
    ] as const) {
      const denied = await execute(name, args, label)
      assert.equal(denied.isError, true, `${label}: ${JSON.stringify(denied)}`)
      assert.match(
        JSON.stringify(denied.result),
        /denies unbridged|inside the project|未经项目授权/,
        `${label}: ${JSON.stringify(denied)}`
      )
      assert.doesNotMatch(JSON.stringify(denied.result), /OUTSIDE_PRIVATE_MARKER/)
    }
    assert.equal(readFileSync(allowed, 'utf8'), 'PROJECT_VISIBLE_MARKER\n')
    assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE_PRIVATE_MARKER\n')
    assert.equal(existsSync(writeTarget), false)
    assert.equal(existsSync(shellTarget), false)
  }
)

test(
  'real native read never substitutes an ASCII-space filename for an authorized Unicode spelling',
  { timeout: 30000 },
  async (t) => {
    const f = await createBootstrapFixture()
    t.after(() => f.close())
    const unicodeName = 'ordinary\u00a0file.txt'
    const asciiName = 'ordinary file.txt'
    writeFileSync(join(f.cwd, unicodeName), 'UNICODE_FILENAME_MARKER\n')
    writeFileSync(join(f.cwd, asciiName), 'ASCII_FILENAME_MARKER\n')
    await f.connection.start()
    await attestBootstrap(f.connection, f.expected, new AbortController().signal)
    const read = async (path: string): Promise<RpcFrame> => {
      const offset = f.frames.length
      f.provider.enqueue(
        { tool: { name: 'read', args: { path } } },
        { text: 'Read scenario completed' }
      )
      await f.connection.prompt(`Read the exact ordinary file named ${path}`)
      const result = f.frames
        .slice(offset)
        .find((frame) => frame.type === 'tool_execution_end' && frame.toolName === 'read')
      assert.ok(result, f.stderr())
      return result
    }
    // SDK18.10.3 normalizes NBSP to ASCII space. Reject this unsupported spelling;
    // silently returning the other ordinary project's file would break the binding.
    const unicode = await read(unicodeName)
    assert.equal(unicode.isError, true, JSON.stringify(unicode))
    assert.match(JSON.stringify(unicode.result), /denies unbridged/)
    assert.doesNotMatch(
      JSON.stringify(unicode.result),
      /ASCII_FILENAME_MARKER|UNICODE_FILENAME_MARKER/
    )
    const ascii = await read(asciiName)
    assert.equal(ascii.isError, false, JSON.stringify(ascii))
    assert.match(JSON.stringify(ascii.result), /ASCII_FILENAME_MARKER/)
    assert.doesNotMatch(JSON.stringify(ascii.result), /UNICODE_FILENAME_MARKER/)
    assert.equal(readFileSync(join(f.cwd, unicodeName), 'utf8'), 'UNICODE_FILENAME_MARKER\n')
    assert.equal(readFileSync(join(f.cwd, asciiName), 'utf8'), 'ASCII_FILENAME_MARKER\n')
  }
)

test(
  'real native read binds ordinary text across the complete raw-literal fallback families',
  { timeout: 60000 },
  async (t) => {
    const f = await createBootstrapFixture()
    t.after(() => f.close())
    await f.connection.start()
    await attestBootstrap(f.connection, f.expected, new AbortController().signal)
    const failures: Array<{ family: string; result: RpcFrame }> = []
    const read = async (path: string, scenario: string): Promise<RpcFrame> => {
      const offset = f.frames.length
      f.provider.enqueue(
        { tool: { name: 'read', args: { path } } },
        { text: `Completed ${scenario}` }
      )
      await f.connection.prompt(`Read exact ordinary text for ${scenario}: ${path}`)
      const result = f.frames
        .slice(offset)
        .find((frame) => frame.type === 'tool_execution_end' && frame.toolName === 'read')
      assert.ok(result, f.stderr())
      return result
    }
    // Explicit examples from the official resolver families, all ordinary files
    // in this temporary project. Each pair is removed before the next is created.
    for (const [family, original, alternative, readableWithoutCollision] of [
      ['exact', 'exact.txt', 'exact.txt:raw', true],
      ['curly quote', "ordinary'file.txt", 'ordinary\u2019file.txt:raw', true],
      ['AM/PM', 'ordinary PM.txt', 'ordinary\u202fPM.txt:raw', true],
      ['NFD', 'caf\u00e9.txt', 'cafe\u0301.txt:raw', true],
      ['NFD + curly', "caf\u00e9'file.txt", 'cafe\u0301\u2019file.txt:raw', true],
      ['shell unescape', 'ordinary\\ file.txt', 'ordinary file.txt:raw', false],
      ['shell + AM/PM', 'ordinary\\ PM.txt', 'ordinary\u202fPM.txt:raw', false],
      ['shell + NFD', 'caf\u00e9\\ file.txt', 'cafe\u0301 file.txt:raw', false],
      ['shell + curly', "ordinary\\'file.txt", 'ordinary\u2019file.txt:raw', false],
      ['shell + NFD + curly', "caf\u00e9\\'file.txt", 'cafe\u0301\u2019file.txt:raw', false]
    ] as const) {
      const originalPath = join(f.cwd, original)
      const alternativePath = join(f.cwd, alternative)
      const originalText = `ORIGINAL_FILE_LABEL ${family}\n`
      const alternativeText = `ALTERNATIVE_FILE_LABEL ${family}\n`
      writeFileSync(originalPath, originalText)
      writeFileSync(alternativePath, alternativeText)
      try {
        const denied = await read(original, `${family} collision`)
        const serialized = JSON.stringify(denied.result)
        if (
          denied.isError !== true ||
          !/denies unbridged/.test(serialized) ||
          /ORIGINAL_FILE_LABEL|ALTERNATIVE_FILE_LABEL/.test(serialized)
        )
          failures.push({ family, result: denied })
        assert.equal(readFileSync(originalPath, 'utf8'), originalText)
        assert.equal(readFileSync(alternativePath, 'utf8'), alternativeText)
        rmSync(alternativePath)
        const allowed = await read(original, `${family} without collision`)
        if (readableWithoutCollision) {
          assert.equal(allowed.isError, false, JSON.stringify(allowed))
          assert.match(JSON.stringify(allowed.result), /ORIGINAL_FILE_LABEL/)
          assert.doesNotMatch(JSON.stringify(allowed.result), /ALTERNATIVE_FILE_LABEL/)
        } else {
          // Bun1.3.14 cannot realpath literal backslashes; pre-R5 must explicitly
          // refuse the spelling rather than surface a guard exception or guess.
          const serializedAllowed = JSON.stringify(allowed.result)
          if (
            allowed.isError !== true ||
            !/denies unbridged/.test(serializedAllowed) ||
            /ORIGINAL_FILE_LABEL|ALTERNATIVE_FILE_LABEL/.test(serializedAllowed)
          )
            failures.push({ family: `${family} unsupported spelling`, result: allowed })
        }
        assert.equal(readFileSync(originalPath, 'utf8'), originalText)
      } finally {
        rmSync(originalPath, { force: true })
        rmSync(alternativePath, { force: true })
      }
    }
    const ordinaryChinese = '普通 文本.txt'
    writeFileSync(join(f.cwd, ordinaryChinese), 'CHINESE_AND_ASCII_SPACE_LABEL\n')
    const chinese = await read(ordinaryChinese, 'Chinese with normal ASCII space')
    assert.equal(chinese.isError, false, JSON.stringify(chinese))
    assert.match(JSON.stringify(chinese.result), /CHINESE_AND_ASCII_SPACE_LABEL/)
    assert.equal(
      readFileSync(join(f.cwd, ordinaryChinese), 'utf8'),
      'CHINESE_AND_ASCII_SPACE_LABEL\n'
    )
    assert.deepEqual(failures, [], 'No raw-literal candidate may substitute another ordinary file')
  }
)
