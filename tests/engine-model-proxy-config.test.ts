import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SafeModelDescriptor } from '../src/main/agent/engine/model-gateway-types'
import {
  serializeRemoteModelProxyConfig,
  writeRemoteModelProxyConfig
} from '../src/main/agent/engine/rpc/model-proxy-config'
import { shellQuote } from '../src/main/agent/wrappers/remote-ssh-session'
import { createModelProxyConfigFixture } from './helpers/modelProxyConfigFixture'

const model: SafeModelDescriptor = {
  provider: 'synthetic-provider',
  id: 'model/id',
  name: 'Reasoning Vision',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }
}
const bearer = 'A'.repeat(43)

test('pi-native serialization preserves safe capabilities and never serializes whole-model credentials, endpoints or functions', () => {
  let resolved = false
  const unsafe = Object.assign({}, model, {
    apiKey: 'vendor-secret',
    baseUrl: 'https://user:password@private-provider/path?secret=value',
    headers: { Authorization: 'vendor-secret' },
    refreshToken: 'oauth-refresh-secret',
    resolveHeaders: () => {
      resolved = true
      return {}
    },
    rawMetadata: { secret: 'raw-secret' }
  })
  const content = serializeRemoteModelProxyConfig({
    models: [unsafe],
    remotePort: 41000,
    gatewayBearer: bearer
  })
  const provider = JSON.parse(content).providers[model.provider]
  assert.deepEqual(provider, {
    baseUrl: 'http://127.0.0.1:41000',
    transport: 'pi-native',
    api: 'openai-completions',
    apiKey: bearer,
    models: [
      {
        id: model.id,
        name: model.name,
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 128000,
        maxTokens: 8192,
        cost: model.cost
      }
    ]
  })
  for (const secret of [
    'vendor-secret',
    'password',
    'private-provider',
    'oauth-refresh-secret',
    'raw-secret',
    'resolveHeaders'
  ])
    assert.ok(!content.includes(secret))
  assert.equal(resolved, false)
})

test('models are grouped by their original provider/id and duplicate or invalid descriptors are refused before writing', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const other = { ...model, provider: 'another-provider' }
  assert.equal(
    Object.keys(
      JSON.parse(
        serializeRemoteModelProxyConfig({
          models: [model, other],
          remotePort: 41000,
          gatewayBearer: bearer
        })
      ).providers
    ).length,
    2
  )
  for (const models of [
    [],
    [model, model],
    [{ ...model, input: ['audio'] }],
    [{ ...model, maxTokens: NaN }],
    [{ ...model, reasoning: 'yes' }]
  ])
    await assert.rejects(
      writeRemoteModelProxyConfig({
        session: fixture.session,
        agentDir: fixture.agentDir,
        sessionId: 'model-session',
        projectRoot: fixture.projectRoot,
        gatewayGeneration: 1,
        models: models as readonly SafeModelDescriptor[],
        remotePort: 41000,
        gatewayBearer: bearer
      })
    )
  for (const value of ['', 'short', 'bad\nheader'.repeat(5)])
    assert.throws(() =>
      serializeRemoteModelProxyConfig({ models: [model], remotePort: 41000, gatewayBearer: value })
    )
})

test('private stdin write atomically replaces an existing644 config, tightens modes and keeps tokens off command/output', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const target = join(fixture.agentDir, 'models.yml')
  await writeFile(target, 'old', { mode: 0o644 })
  await chmod(fixture.agentDir, 0o755)
  await writeRemoteModelProxyConfig({
    session: fixture.session,
    sessionId: 'model-session',
    projectRoot: fixture.projectRoot,
    gatewayGeneration: 1,
    agentDir: fixture.agentDir,
    models: [model],
    remotePort: 41000,
    gatewayBearer: bearer
  })
  assert.equal((await stat(target)).mode & 0o777, 0o600)
  assert.equal((await stat(fixture.agentDir)).mode & 0o777, 0o700)
  assert.equal(
    await readFile(target, 'utf8'),
    serializeRemoteModelProxyConfig({ models: [model], remotePort: 41000, gatewayBearer: bearer }) +
      '\n'
  )
  assert.deepEqual(await readdir(fixture.agentDir), ['models.yml', 'phi-model-metadata.json'])
  assert.ok(fixture.records.some((record) => record.input?.includes(bearer)))
  assert.ok(fixture.records.every((record) => !record.command.includes(bearer)))
})

test('concurrent sessions publish independent bearer/model configs without overwriting each other', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const second = await fixture.generation()
  const secondBearer = 'B'.repeat(43)
  await Promise.all([
    writeRemoteModelProxyConfig({
      session: fixture.session,
      sessionId: 'model-session',
      projectRoot: fixture.projectRoot,
      gatewayGeneration: 1,
      agentDir: fixture.agentDir,
      models: [model],
      remotePort: 41000,
      gatewayBearer: bearer
    }),
    writeRemoteModelProxyConfig({
      session: fixture.session,
      sessionId: 'model-session',
      projectRoot: fixture.projectRoot,
      gatewayGeneration: 1,
      agentDir: second,
      models: [{ ...model, id: 'second-model' }],
      remotePort: 42000,
      gatewayBearer: secondBearer
    })
  ])
  const firstContent = await readFile(join(fixture.agentDir, 'models.yml'), 'utf8')
  const secondContent = await readFile(join(second, 'models.yml'), 'utf8')
  assert.ok(firstContent.includes(bearer) && !firstContent.includes(secondBearer))
  assert.ok(secondContent.includes(secondBearer) && !secondContent.includes(bearer))
  assert.ok(secondContent.includes('second-model'))
})

test('shared user agent directories and missing generations are refused without creating them', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  for (const agentDir of [
    join(fixture.runtimeRoot, 'omp-home/agent'),
    join(fixture.root, '.omp/agent'),
    join(fixture.runtimeRoot, 'rpc-sessions', 'a'.repeat(36), 'home/agent')
  ])
    await assert.rejects(
      writeRemoteModelProxyConfig({
        session: fixture.session,
        sessionId: 'model-session',
        projectRoot: fixture.projectRoot,
        gatewayGeneration: 1,
        agentDir,
        models: [model],
        remotePort: 41000,
        gatewayBearer: bearer
      })
    )
  assert.deepEqual(await readdir(fixture.agentDir), [])
})

test('symlink destinations cannot redirect secret writes outside the private generation', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const outside = join(fixture.root, 'outside')
  await writeFile(outside, 'unchanged', { mode: 0o644 })
  await symlink(outside, join(fixture.agentDir, 'models.yml'))
  await assert.rejects(
    writeRemoteModelProxyConfig({
      session: fixture.session,
      sessionId: 'model-session',
      projectRoot: fixture.projectRoot,
      gatewayGeneration: 1,
      agentDir: fixture.agentDir,
      models: [model],
      remotePort: 41000,
      gatewayBearer: bearer
    })
  )
  assert.equal(await readFile(outside, 'utf8'), 'unchanged')
  assert.equal((await stat(outside)).mode & 0o777, 0o644)
})

test('partial stdin cannot replace an existing valid config or leave a secret temporary file', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const target = join(fixture.agentDir, 'models.yml')
  await writeFile(target, 'old-safe-content', { mode: 0o600 })
  const write = fixture.session.execWithInput
  fixture.session.execWithInput = (command, input, options) =>
    write(command, input.slice(0, Math.floor(input.length / 2)), options)
  await assert.rejects(
    writeRemoteModelProxyConfig({
      session: fixture.session,
      sessionId: 'model-session',
      projectRoot: fixture.projectRoot,
      gatewayGeneration: 1,
      agentDir: fixture.agentDir,
      models: [model],
      remotePort: 41000,
      gatewayBearer: bearer
    }),
    /write failed/
  )
  assert.equal(await readFile(target, 'utf8'), 'old-safe-content')
  assert.deepEqual(await readdir(fixture.agentDir), ['models.yml'])
})

test('cancellation before publication cleans partial config without touching another generation', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const second = await fixture.generation()
  await writeFile(join(second, 'models.yml'), 'another-generation', { mode: 0o600 })
  const write = fixture.session.execWithInput
  const controller = new AbortController()
  fixture.session.execWithInput = (command, input, options) => {
    setTimeout(() => controller.abort(), 30)
    return write(command.replace('awk -v ', 'sleep 2\nawk -v '), input, options)
  }
  await assert.rejects(
    writeRemoteModelProxyConfig({
      session: fixture.session,
      sessionId: 'model-session',
      projectRoot: fixture.projectRoot,
      gatewayGeneration: 1,
      agentDir: fixture.agentDir,
      models: [model],
      remotePort: 41000,
      gatewayBearer: bearer,
      signal: controller.signal
    }),
    { name: 'AbortError' }
  )
  assert.deepEqual(await readdir(fixture.agentDir), [])
  assert.equal(await readFile(join(second, 'models.yml'), 'utf8'), 'another-generation')
})

test('foreign-owner metadata is refused before changing the target or persisting a new bearer', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const target = join(fixture.agentDir, 'models.yml')
  await writeFile(target, 'foreign-sentinel', { mode: 0o644 })
  const shimDir = join(fixture.root, 'stat-shim')
  await mkdir(shimDir)
  const shim = join(shimDir, 'stat')
  await writeFile(
    shim,
    `#!/bin/sh\nfor last do :; done\nif [ "$last" = ${shellQuote(target)} ] && [ "$2" = %u ]; then printf '${(process.getuid?.() ?? 1000) + 1}\\n'; exit 0; fi\nexec /usr/bin/stat "$@"\n`
  )
  await chmod(shim, 0o700)
  fixture.setPath(`${shimDir}:/usr/bin:/bin`)
  await assert.rejects(
    writeRemoteModelProxyConfig({
      session: fixture.session,
      sessionId: 'model-session',
      projectRoot: fixture.projectRoot,
      gatewayGeneration: 1,
      agentDir: fixture.agentDir,
      models: [model],
      remotePort: 41000,
      gatewayBearer: bearer
    })
  )
  assert.equal(await readFile(target, 'utf8'), 'foreign-sentinel')
  assert.equal((await stat(target)).mode & 0o777, 0o644)
  assert.deepEqual(await readdir(fixture.agentDir), ['models.yml'])
})

test('managed ancestor symlinks cannot redirect gateway configuration to another directory', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const outside = join(fixture.root, 'outside-directory')
  await mkdir(outside)
  const symbolicHome = join(fixture.agentDir, '..')
  await rm(symbolicHome, { recursive: true })
  await symlink(outside, symbolicHome)
  await assert.rejects(
    writeRemoteModelProxyConfig({
      session: fixture.session,
      sessionId: 'model-session',
      projectRoot: fixture.projectRoot,
      gatewayGeneration: 1,
      agentDir: fixture.agentDir,
      models: [model],
      remotePort: 41000,
      gatewayBearer: bearer
    })
  )
  assert.deepEqual(await readdir(outside), [])
})

test('untrusted SSH failure text and payload cannot escape through a config error cause', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  fixture.session.execWithInput = async () => {
    throw new Error(`Untrusted SSH stderr: ${bearer}`)
  }
  await assert.rejects(
    writeRemoteModelProxyConfig({
      session: fixture.session,
      sessionId: 'model-session',
      projectRoot: fixture.projectRoot,
      gatewayGeneration: 1,
      agentDir: fixture.agentDir,
      models: [model],
      remotePort: 41000,
      gatewayBearer: bearer
    }),
    (error: Error) => {
      assert.ok(!error.message.includes(bearer))
      assert.equal(error.cause, undefined)
      return true
    }
  )
})
