import assert from 'node:assert/strict'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { SafeModelDescriptor } from '../src/main/agent/engine/model-gateway-types'
import { writeRemoteModelProxyConfig } from '../src/main/agent/engine/rpc/model-proxy-config'
import { createModelProxyConfigFixture } from './helpers/modelProxyConfigFixture'
import { shellQuote } from '../src/main/agent/wrappers/remote-ssh-session'

const model: SafeModelDescriptor = {
  provider: 'synthetic-provider',
  id: 'nullable-model',
  name: 'Unknown Limits',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: null,
  maxTokens: null
}
const bearer = 'A'.repeat(43)

test('nullable capability metadata remains exact and credential-free beside bootstrap-only model schema placeholders', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const extended = Object.assign({}, model, {
    baseUrl: 'https://vendor-secret.invalid',
    apiKey: 'vendor-secret',
    headers: { Authorization: 'vendor-secret' },
    discovery: { command: 'vendor-command' },
    rawMetadata: { secret: 'vendor-secret' }
  })
  const identity = await writeRemoteModelProxyConfig({
    session: fixture.session,
    agentDir: fixture.agentDir,
    sessionId: 'nullable-session',
    projectRoot: fixture.projectRoot,
    gatewayGeneration: 3,
    models: [extended],
    remotePort: 41000,
    gatewayBearer: bearer
  })
  const rawMetadata = await readFile(join(fixture.agentDir, 'phi-model-metadata.json'), 'utf8')
  const metadata = JSON.parse(rawMetadata)
  assert.deepEqual(metadata, { schema: 1, ...identity, models: [model] })
  assert.equal(identity.nonce, fixture.agentDir.split('/').at(-3))
  assert.equal(identity.gatewayGeneration, 3)
  assert.ok(!rawMetadata.includes(bearer))
  assert.ok(!rawMetadata.includes('vendor-secret') && !rawMetadata.includes('vendor-command'))
  const configured = JSON.parse(await readFile(join(fixture.agentDir, 'models.yml'), 'utf8'))
    .providers[model.provider].models[0]
  assert.equal(Object.hasOwn(configured, 'contextWindow'), false)
  assert.equal(Object.hasOwn(configured, 'maxTokens'), false)
  for (const file of ['models.yml', 'phi-model-metadata.json'])
    assert.equal((await stat(join(fixture.agentDir, file))).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(fixture.agentDir), ['models.yml', 'phi-model-metadata.json'])
})

test('failure between the two atomic renames restores the old complete private pair', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const options = {
    session: fixture.session,
    agentDir: fixture.agentDir,
    sessionId: 'model-session',
    projectRoot: fixture.projectRoot,
    gatewayGeneration: 1,
    models: [model],
    remotePort: 41000,
    gatewayBearer: bearer
  }
  await writeRemoteModelProxyConfig(options)
  const before = await Promise.all(
    ['models.yml', 'phi-model-metadata.json'].map((file) =>
      readFile(join(fixture.agentDir, file), 'utf8')
    )
  )
  const write = fixture.session.execWithInput
  fixture.session.execWithInput = (command, input, callOptions) =>
    write(
      command.replace(
        'mv -f -- "$txn/new-metadata" "$metadata"',
        'exit 1\nmv -f -- "$txn/new-metadata" "$metadata"'
      ),
      input,
      callOptions
    )
  await assert.rejects(
    writeRemoteModelProxyConfig({
      ...options,
      gatewayBearer: 'B'.repeat(43),
      gatewayGeneration: 2
    }),
    /write failed/
  )
  assert.deepEqual(
    await Promise.all(
      ['models.yml', 'phi-model-metadata.json'].map((file) =>
        readFile(join(fixture.agentDir, file), 'utf8')
      )
    ),
    before
  )
  assert.deepEqual(await readdir(fixture.agentDir), ['models.yml', 'phi-model-metadata.json'])
})

test('cancellation after the first rename rolls back both files before returning', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const options = {
    session: fixture.session,
    agentDir: fixture.agentDir,
    sessionId: 'model-session',
    projectRoot: fixture.projectRoot,
    gatewayGeneration: 1,
    models: [model],
    remotePort: 41000,
    gatewayBearer: bearer
  }
  await writeRemoteModelProxyConfig(options)
  const before = await Promise.all(
    ['models.yml', 'phi-model-metadata.json'].map((file) =>
      readFile(join(fixture.agentDir, file), 'utf8')
    )
  )
  const marker = join(fixture.agentDir, '.test-halfway')
  const write = fixture.session.execWithInput
  const controller = new AbortController()
  fixture.session.execWithInput = async (command, input, callOptions) => {
    const pending = write(
      command.replace(
        'mv -f -- "$txn/new-metadata" "$metadata"',
        `printf reached > ${shellQuote(marker)}\nsleep 5\nmv -f -- "$txn/new-metadata" "$metadata"`
      ),
      input,
      callOptions
    )
    void pending.catch(() => undefined)
    let reached = false
    for (let attempt = 0; attempt < 400; attempt++) {
      if (
        await stat(marker).then(
          () => true,
          () => false
        )
      ) {
        reached = true
        break
      }
      await delay(5)
    }
    assert.equal(reached, true)
    controller.abort()
    return pending
  }
  await assert.rejects(
    writeRemoteModelProxyConfig({
      ...options,
      gatewayGeneration: 2,
      gatewayBearer: 'B'.repeat(43),
      signal: controller.signal
    }),
    { name: 'AbortError' }
  )
  await rm(marker)
  assert.deepEqual(
    await Promise.all(
      ['models.yml', 'phi-model-metadata.json'].map((file) =>
        readFile(join(fixture.agentDir, file), 'utf8')
      )
    ),
    before
  )
  assert.deepEqual(await readdir(fixture.agentDir), ['models.yml', 'phi-model-metadata.json'])
})

test('lost confirmation after publication restores the old pair using the verified private transaction backup', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const options = {
    session: fixture.session,
    agentDir: fixture.agentDir,
    sessionId: 'model-session',
    projectRoot: fixture.projectRoot,
    gatewayGeneration: 1,
    models: [model],
    remotePort: 41000,
    gatewayBearer: bearer
  }
  await writeRemoteModelProxyConfig(options)
  const before = await Promise.all(
    ['models.yml', 'phi-model-metadata.json'].map((file) =>
      readFile(join(fixture.agentDir, file), 'utf8')
    )
  )
  const write = fixture.session.execWithInput
  fixture.session.execWithInput = async (...args) => {
    await write(...args)
    throw new Error('SSH confirmation disconnected')
  }
  await assert.rejects(
    writeRemoteModelProxyConfig({
      ...options,
      gatewayGeneration: 2,
      gatewayBearer: 'B'.repeat(43)
    }),
    /write failed/
  )
  assert.deepEqual(
    await Promise.all(
      ['models.yml', 'phi-model-metadata.json'].map((file) =>
        readFile(join(fixture.agentDir, file), 'utf8')
      )
    ),
    before
  )
})

test('identity and capability failures produce no write and cannot activate metadata for another generation', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const options = {
    session: fixture.session,
    agentDir: fixture.agentDir,
    sessionId: 'model-session',
    projectRoot: fixture.projectRoot,
    gatewayGeneration: 1,
    models: [model],
    remotePort: 41000,
    gatewayBearer: bearer
  }
  for (const invalid of [
    { gatewayGeneration: 0 },
    { sessionId: 'bad\nidentity' },
    { projectRoot: `${fixture.projectRoot}/../other` }
  ])
    await assert.rejects(writeRemoteModelProxyConfig({ ...options, ...invalid }))
  assert.equal(fixture.records.length, 0)
  assert.deepEqual(await readdir(fixture.agentDir), [])
})

test('cancelling a queued same-generation writer cannot let a third writer overtake its active predecessor', async (t) => {
  const fixture = await createModelProxyConfigFixture()
  t.after(fixture.cleanup)
  const options = {
    session: fixture.session,
    agentDir: fixture.agentDir,
    sessionId: 'model-session',
    projectRoot: fixture.projectRoot,
    gatewayGeneration: 1,
    models: [model],
    remotePort: 41000,
    gatewayBearer: bearer
  }
  const write = fixture.session.execWithInput
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let writes = 0
  fixture.session.execWithInput = async (...args) => {
    writes++
    if (writes === 1) {
      entered()
      await gate
    }
    return write(...args)
  }
  const first = writeRemoteModelProxyConfig(options)
  void first.catch(() => undefined)
  await started
  const controller = new AbortController()
  const queued = writeRemoteModelProxyConfig({
    ...options,
    gatewayGeneration: 2,
    gatewayBearer: 'B'.repeat(43),
    signal: controller.signal
  })
  const rejected = assert.rejects(queued, { name: 'AbortError' })
  controller.abort()
  await rejected
  const third = writeRemoteModelProxyConfig({
    ...options,
    gatewayGeneration: 3,
    gatewayBearer: 'C'.repeat(43)
  })
  void third.catch(() => undefined)
  try {
    await delay(50)
    assert.equal(writes, 1)
  } finally {
    release()
  }
  await first
  await third
  assert.equal(writes, 2)
  const metadata = JSON.parse(
    await readFile(join(fixture.agentDir, 'phi-model-metadata.json'), 'utf8')
  )
  assert.equal(metadata.gatewayGeneration, 3)
  assert.deepEqual(await readdir(fixture.agentDir), ['models.yml', 'phi-model-metadata.json'])
})
