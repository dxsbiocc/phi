import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { chmod, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import {
  recoverRemoteSession,
  type RemoteSessionRecoveryOptions
} from '../src/main/agent/engine/rpc/session-recovery'
import { deriveRemoteSessionPaths } from '../src/main/agent/engine/rpc/session-storage/paths'
import {
  RemoteSessionStorageError,
  type RemoteSessionReference
} from '../src/main/agent/engine/rpc/session-storage/types'
import { createInitializationWire, deferred } from './helpers/rpc-initialization-wire'
import {
  createRemoteSessionRecoveryFixture,
  recoveryModel,
  replacementModel
} from './helpers/remoteSessionRecoveryFixture'

async function unit(
  patch: Record<string, unknown> = {},
  change?: Record<string, unknown>
): Promise<{
  options: RemoteSessionRecoveryOptions
  reference: RemoteSessionReference
  wire: ReturnType<typeof createInitializationWire>
  connection: RpcConnection
  controller: AbortController
  published(): number
  interrupted(): number
  selected(): number
}> {
  const scope = {
    hostProfileId: 'host',
    bindingHash: 'a'.repeat(64),
    projectId: 'project',
    projectRoot: '/remote/project',
    runtimeRoot: '/remote/runtime',
    phiSessionId: 'phi-session'
  }
  const paths = deriveRemoteSessionPaths(scope)
  const reference: RemoteSessionReference = {
    ...scope,
    kind: 'remote-omp',
    version: 1,
    durableSessionKey: paths.durableSessionKey,
    ompVersion: '18.10.3',
    ompSessionId: 'omp-session',
    journalBasename: 'journal.jsonl'
  }
  const state = {
    sessionId: reference.ompSessionId,
    sessionFile: join(paths.journals, reference.journalBasename),
    model: {
      ...recoveryModel,
      baseUrl: 'https://secret.invalid',
      headers: { authorization: 'secret' }
    },
    thinkingLevel: 'high',
    isStreaming: false,
    isCompacting: false,
    isSettled: true,
    queuedMessageCount: 0,
    hasPendingAsyncWork: false,
    messageCount: 0,
    ...patch
  }
  const wire = createInitializationWire((command, respond, emit) => {
    if (command.type === 'switch_session' || command.type === 'new_session') {
      if (change?.agentStart) emit({ type: 'agent_start' })
      respond({ cancelled: false, ...change })
    } else if (command.type === 'get_state') respond(state)
    else if (command.type === 'get_messages_page') respond({ messages: [], totalMessages: 0 })
    else return false
    return true
  })
  const connection = new RpcConnection(() => wire.transport)
  await connection.start()
  const controller = new AbortController()
  let published = 0
  let interrupted = 0
  let selected = 0
  const options: RemoteSessionRecoveryOptions = {
    action: { type: 'resume', reference, savedModel: recoveryModel },
    connection,
    control: connection.bindControl(),
    signal: controller.signal,
    availableModels: [recoveryModel, replacementModel],
    storage: {
      scope,
      paths,
      lease: {
        signal: new AbortController().signal,
        lost: new Promise<never>(() => undefined),
        assertActive() {
          return undefined
        },
        release: async () => undefined
      }
    },
    preflight: async () => ({
      journalPath: state.sessionFile,
      ompSessionId: reference.ompSessionId,
      cwd: scope.projectRoot,
      headerVersion: 3,
      verification: 'bounded-header',
      fileIdentity: 'file-1',
      fingerprint: 'revision-1'
    }),
    verifySavedState: async () => ({ model: recoveryModel, modelRole: 'default' }),
    selectModel: async () => {
      selected++
    },
    verifyAttachment: async (identity) => ({ ...identity, leafId: null }),
    publish: async () => {
      published++
    },
    interrupt: async () => {
      interrupted++
    }
  }
  return {
    options,
    reference,
    wire,
    connection,
    controller,
    published: () => published,
    interrupted: () => interrupted,
    selected: () => selected
  }
}

test('resume omits model selectors and returns immutable safe adoption outcome', async () => {
  const f = await unit()
  try {
    const result = await recoverRemoteSession(f.options)
    const command = f.wire.commands.find((command) => command.type === 'switch_session')!
    assert.equal('provider' in command, false)
    assert.equal('modelId' in command, false)
    assert.equal(result.modelPolicy, 'restored')
    assert.equal(result.reference.phiSessionId, 'phi-session')
    assert.equal(result.checkpoint.ompSessionId, 'omp-session')
    assert.deepEqual(result.model, recoveryModel)
    assert.equal(JSON.stringify(result).includes('secret'), false)
    assert.equal(Object.isFrozen(result.checkpoint), true)
    assert.equal(Object.isFrozen(result.reference), true)
    assert.equal(f.published(), 1)
    assert.equal(f.selected(), 0)
    assert.equal(
      f.wire.commands.some((command) => command.type === 'prompt'),
      false
    )
  } finally {
    await f.connection.close()
  }
})

test('resume reselects the same model when the remotely proven role is not default', async () => {
  const f = await unit()
  try {
    const result = await recoverRemoteSession({
      ...f.options,
      verifySavedState: async () => ({ model: recoveryModel, modelRole: 'smol' })
    })
    assert.equal(result.modelPolicy, 'restored')
    assert.equal(f.selected(), 1)
  } finally {
    await f.connection.close()
  }
})

test('only explicit replacement sends a complete exact model pair', async () => {
  const f = await unit({ model: replacementModel })
  try {
    const result = await recoverRemoteSession({
      ...f.options,
      action: {
        type: 'resume',
        reference: f.reference,
        savedModel: recoveryModel,
        replacement: replacementModel
      }
    })
    const command = f.wire.commands.find((command) => command.type === 'switch_session')!
    assert.equal(command.provider, replacementModel.provider)
    assert.equal(command.modelId, replacementModel.id)
    assert.equal(result.modelPolicy, 'explicit-replacement')
  } finally {
    await f.connection.close()
  }
})

for (const id of ['contract', 'contract-*', 'missing-model'])
  test(`unavailable exact saved model ${id} cannot fuzzy fallback`, async () => {
    const f = await unit()
    try {
      await assert.rejects(
        recoverRemoteSession({
          ...f.options,
          action: {
            type: 'resume',
            reference: f.reference,
            savedModel: { provider: recoveryModel.provider, id }
          }
        }),
        { code: 'MODEL_UNAVAILABLE' }
      )
      assert.equal(
        f.wire.commands.some((command) => command.type === 'switch_session'),
        false
      )
      assert.equal(f.published(), 0)
    } finally {
      await f.connection.close()
    }
  })

for (const [name, state, code] of [
  ['cancelled', {}, 'RESTORE_CANCELLED'],
  ['wrong SDK id', { sessionId: 'other' }, 'IDENTITY_MISMATCH'],
  ['relocated journal', { sessionFile: '/other.jsonl' }, 'IDENTITY_MISMATCH'],
  ['queued prompts', { queuedMessageCount: 1 }, 'SESSION_BUSY'],
  ['pending async work', { hasPendingAsyncWork: true }, 'SESSION_BUSY'],
  ['unexpected agent turn', {}, 'UNEXPECTED_EXECUTION'],
  ['wrong restored model', { model: replacementModel }, 'MODEL_UNAVAILABLE']
] as const)
  test(`recovery rejects ${name} without adoption`, async () => {
    const f = await unit(
      state,
      name === 'cancelled'
        ? { cancelled: true }
        : name === 'unexpected agent turn'
          ? { agentStart: true }
          : undefined
    )
    try {
      await assert.rejects(recoverRemoteSession(f.options), { code })
      assert.equal(f.published(), 0)
      assert.ok(f.interrupted() >= 1)
    } finally {
      await f.connection.close()
    }
  })

for (const code of ['FILE_MISSING', 'FILE_INVALID', 'PERMISSION_DENIED'] as const)
  test(`strict ${code} preflight blocks switch`, async () => {
    const f = await unit()
    try {
      await assert.rejects(
        recoverRemoteSession({
          ...f.options,
          preflight: async () => {
            throw new RemoteSessionStorageError(code, 'Synthetic strict preflight failure')
          }
        }),
        { code }
      )
      assert.equal(
        f.wire.commands.some((command) => command.type === 'switch_session'),
        false
      )
    } finally {
      await f.connection.close()
    }
  })

test('deleted/replaced journal after switch cannot publish a new reference', async () => {
  const f = await unit()
  const preflight = f.options.preflight
  let calls = 0
  try {
    await assert.rejects(
      recoverRemoteSession({
        ...f.options,
        preflight: async (reference, signal) => ({
          ...(await preflight(reference, signal)),
          fileIdentity: ++calls === 1 ? 'original' : 'replacement'
        })
      }),
      { code: 'IDENTITY_MISMATCH' }
    )
    assert.equal(f.published(), 0)
  } finally {
    await f.connection.close()
  }
})

test('cancellation settles a pending preflight and refuses late completion', async () => {
  const f = await unit()
  const gate = deferred<Awaited<ReturnType<typeof f.options.preflight>>>()
  try {
    const pending = recoverRemoteSession({ ...f.options, preflight: () => gate.promise })
    f.controller.abort()
    await assert.rejects(pending, { code: 'GENERATION_REVOKED' })
    gate.resolve(await f.options.preflight(f.reference, new AbortController().signal))
    assert.equal(f.published(), 0)
  } finally {
    await f.connection.close()
  }
})

async function scanFiles(root: string): Promise<Array<{ path: string; bytes: Buffer }>> {
  const files: Array<{ path: string; bytes: Buffer }> = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...(await scanFiles(path)))
    else if (entry.isFile()) files.push({ path, bytes: await readFile(path) })
  }
  return files
}

test(
  'real persistent CLI explicit restore appends no model change when model and role are unchanged',
  { timeout: 60000 },
  async () => {
    const f = await createRemoteSessionRecoveryFixture()
    try {
      const first = await f.open()
      const created = await recoverRemoteSession(
        first.options({ type: 'new', model: recoveryModel })
      )
      await first.close()
      const before = (await readFile(created.checkpoint.journalPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const savedSelection = before.findLast((entry) => entry.type === 'model_change')
      assert.deepEqual(
        { model: savedSelection?.model, role: savedSelection?.role },
        { model: `${recoveryModel.provider}/${recoveryModel.id}`, role: 'default' }
      )

      const second = await f.open()
      await recoverRemoteSession(
        second.options({
          type: 'resume',
          reference: created.reference,
          savedModel: recoveryModel
        })
      )
      const appended = (await readFile(created.checkpoint.journalPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .slice(before.length)

      assert.deepEqual(
        appended.filter((entry) => entry.type === 'model_change'),
        []
      )
    } finally {
      await f.close()
    }
  }
)

test(
  'real persistent CLI explicit replacement still records the different desired model',
  { timeout: 60000 },
  async () => {
    const f = await createRemoteSessionRecoveryFixture()
    try {
      const first = await f.open()
      const created = await recoverRemoteSession(
        first.options({ type: 'new', model: recoveryModel })
      )
      await first.close()
      const before = (await readFile(created.checkpoint.journalPath, 'utf8'))
        .split('\n')
        .filter(Boolean).length

      const second = await f.open()
      const restored = await recoverRemoteSession(
        second.options({
          type: 'resume',
          reference: created.reference,
          savedModel: recoveryModel,
          replacement: replacementModel
        })
      )
      const appended = (await readFile(created.checkpoint.journalPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .slice(before)

      assert.equal(restored.modelPolicy, 'explicit-replacement')
      assert.deepEqual(restored.model, replacementModel)
      assert.ok(
        appended.some(
          (entry) =>
            entry.type === 'model_change' &&
            entry.model === `${replacementModel.provider}/${replacementModel.id}` &&
            entry.role === 'default'
        )
      )
    } finally {
      await f.close()
    }
  }
)

test(
  'real persistent CLI fresh sessions still record the selected model',
  { timeout: 60000 },
  async () => {
    const f = await createRemoteSessionRecoveryFixture()
    try {
      const channel = await f.open()
      const created = await recoverRemoteSession(
        channel.options({ type: 'new', model: recoveryModel })
      )
      const modelChanges = (await readFile(created.checkpoint.journalPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.type === 'model_change')

      assert.equal(created.modelPolicy, 'fresh')
      assert.deepEqual(
        modelChanges.map(({ model, role }) => ({ model, role })),
        [{ model: `${recoveryModel.provider}/${recoveryModel.id}`, role: 'default' }]
      )
    } finally {
      await f.close()
    }
  }
)

test(
  'real persistent CLI resumes the same journal with fresh HOME and hydrated image history',
  { timeout: 60000 },
  async () => {
    const f = await createRemoteSessionRecoveryFixture()
    try {
      const first = await f.open()
      const firstConfig = await readFile(join(first.home, '.omp/agent/models.yml'), 'utf8')
      const created = await recoverRemoteSession(
        first.options({ type: 'new', model: recoveryModel })
      )
      const header = (await readFile(created.checkpoint.journalPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((entry) => entry.type === 'session')
      assert.equal(header.id, created.reference.ompSessionId)
      assert.equal(await realpath(header.cwd), f.fixture.scope.projectRoot)
      assert.equal(created.messages.length, 0)
      assert.equal(f.provider.requests.length, 0)
      const png = (await readFile(new URL('../resources/icon.png', import.meta.url))).toString(
        'base64'
      )
      f.provider.enqueue({ text: '先前历史 retained' })
      await first.connection.prompt('请记住 before restart', {
        images: [{ type: 'image', mimeType: 'image/png', data: png }]
      })
      const durable = await scanFiles(f.fixture.paths.directory)
      const providerImage = /data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/.exec(
        JSON.stringify(f.provider.requests[0])
      )
      assert.ok(providerImage, 'Actual SDK model request must contain the normalized image')
      const normalizedImage = providerImage[1]
      // SDK normalizes PNG to WebP before sending/persisting; compare its actual provider bytes.
      assert.ok(
        durable.some(
          (file) =>
            file.path.startsWith(f.fixture.paths.blobs + '/') &&
            file.bytes.equals(Buffer.from(normalizedImage, 'base64'))
        )
      )
      assert.equal(
        durable.some((file) =>
          file.bytes.includes(Buffer.from('ephemeral-proxy-bearer-recovery-only'))
        ),
        false
      )
      const journal = created.checkpoint.journalPath
      const goal = await first.connection.request<{ state: { enabled: boolean } }>({
        type: 'goal',
        op: 'create',
        objective: 'Saved active goal must await explicit user input',
        token_budget: 10000
      })
      assert.equal(goal.state.enabled, true)
      const beforeRestart = await first.connection.request<{ messageCount: number }>({
        type: 'get_state'
      })
      const activeJournal = await readFile(journal)
      await first.close()
      // Retain the actual SDK's active-goal checkpoint, independent of shutdown bookkeeping.
      await writeFile(journal, activeJournal, { mode: 0o600 })
      await assert.rejects(readFile(join(first.home, '.omp/agent/models.yml')), { code: 'ENOENT' })
      assert.ok((await readFile(journal)).length > 0)
      const second = await f.open(replacementModel.id)
      const secondConfig = await readFile(join(second.home, '.omp/agent/models.yml'), 'utf8')
      assert.notEqual(
        JSON.parse(firstConfig).providers[recoveryModel.provider].apiKey,
        JSON.parse(secondConfig).providers[recoveryModel.provider].apiKey
      )
      const restored = await recoverRemoteSession(
        second.options({ type: 'resume', reference: created.reference, savedModel: recoveryModel })
      )
      assert.equal(restored.modelPolicy, 'restored')
      assert.equal(restored.reference.ompSessionId, created.reference.ompSessionId)
      assert.equal(restored.checkpoint.journalPath, journal)
      assert.deepEqual(restored.model, recoveryModel)
      assert.equal(restored.messages.length, beforeRestart.messageCount)
      const resumedState = await second.connection.request<{ goal: { enabled: boolean } }>({
        type: 'get_state'
      })
      assert.equal(resumedState.goal.enabled, true)
      assert.equal(second.frames.filter((frame) => frame.type === 'agent_start').length, 0)
      assert.equal(f.provider.requests.length, 1)
      f.provider.enqueue({ text: 'after restart' })
      await second.connection.prompt('继续新的用户请求')
      assert.ok(JSON.stringify(f.provider.requests[1]).includes('before restart'))
      assert.ok(JSON.stringify(f.provider.requests[1]).includes('先前历史 retained'))
      assert.ok(JSON.stringify(f.provider.requests[1]).includes(normalizedImage))
      await second.close()
      assert.equal(second.running(), false)
      const afterRestart = await scanFiles(f.fixture.paths.directory)
      assert.equal(
        afterRestart.some((file) =>
          file.bytes.includes(Buffer.from('ephemeral-proxy-bearer-recovery-only'))
        ),
        false
      )
      const imageHash = createHash('sha256')
        .update(Buffer.from(normalizedImage, 'base64'))
        .digest('hex')
      await rm(join(f.fixture.paths.blobs, imageHash))
      const missingAsset = await f.open()
      await assert.rejects(
        recoverRemoteSession(
          missingAsset.options({
            type: 'resume',
            reference: created.reference,
            savedModel: recoveryModel
          })
        ),
        { code: 'ASSET_MISSING' }
      )
      assert.equal(
        missingAsset.frames.some((frame) => frame.type === 'agent_start'),
        false
      )
      assert.equal(f.provider.requests.length, 2)
    } finally {
      await f.close()
    }
  }
)

test(
  'real SDK missing-file auto-create race is rejected after switch, without adoption or prompt',
  { timeout: 60000 },
  async () => {
    const f = await createRemoteSessionRecoveryFixture()
    try {
      const first = await f.open()
      const created = await recoverRemoteSession(
        first.options({ type: 'new', model: recoveryModel })
      )
      await first.close()
      const second = await f.open()
      const options = second.options({
        type: 'resume',
        reference: created.reference,
        savedModel: recoveryModel
      })
      let calls = 0
      await assert.rejects(
        recoverRemoteSession({
          ...options,
          verifySavedState: async (reference, signal) => {
            const result = await options.verifySavedState(reference, signal)
            if (++calls === 1) await rm(created.checkpoint.journalPath)
            return result
          },
          publish: async () => assert.fail('Must not adopt SDK auto-created session')
        }),
        { code: 'IDENTITY_MISMATCH' }
      )
      assert.equal(f.provider.requests.length, 0)
      // Public switch_session can create an empty target; rejection is detection, not strict FD adoption.
      const replacementHeader = (await readFile(created.checkpoint.journalPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((entry) => entry.type === 'session')
      assert.notEqual(replacementHeader.id, created.reference.ompSessionId)
    } finally {
      await f.close()
    }
  }
)

test(
  'real storage rejects missing/corrupt/permission headers before SDK switching',
  { timeout: 60000 },
  async () => {
    const f = await createRemoteSessionRecoveryFixture()
    try {
      const channel = await f.open()
      const created = await recoverRemoteSession(
        channel.options({ type: 'new', model: recoveryModel })
      )
      const path = created.checkpoint.journalPath
      const original = await readFile(path)
      await channel.close()
      const attempt = async (code: string): Promise<void> => {
        const next = await f.open()
        try {
          await assert.rejects(
            recoverRemoteSession(
              next.options({
                type: 'resume',
                reference: created.reference,
                savedModel: recoveryModel
              })
            ),
            { code }
          )
        } finally {
          await next.close()
        }
      }
      await chmod(path, 0o644)
      await attempt('PERMISSION_DENIED')
      await chmod(path, 0o600)
      await writeFile(path, '{bad-json}\n', { mode: 0o600 })
      await attempt('FILE_INVALID')
      for (const unavailable of ['contract', 'contract-*']) {
        const changed =
          original
            .toString('utf8')
            .trimEnd()
            .split('\n')
            .map((line) => {
              const entry = JSON.parse(line)
              if (entry.type === 'model_change')
                entry.model = `${recoveryModel.provider}/${unavailable}`
              return JSON.stringify(entry)
            })
            .join('\n') + '\n'
        await writeFile(path, changed, { mode: 0o600 })
        await attempt('MODEL_UNAVAILABLE')
      }
      await writeFile(path, original, { mode: 0o600 })
      await rename(path, join(dirname(path), 'original-backup.jsonl'))
      await attempt('FILE_MISSING')
      assert.equal(f.provider.requests.length, 0)
    } finally {
      await f.close()
    }
  }
)

test(
  'real official pages and v2 chunks retain a Unicode message larger than1MiB',
  { timeout: 60000 },
  async () => {
    const f = await createRemoteSessionRecoveryFixture()
    try {
      const first = await f.open()
      const created = await recoverRemoteSession(
        first.options({ type: 'new', model: recoveryModel })
      )
      const text = Array.from(
        { length: 2500 },
        (_, index) =>
          `${index}:${createHash('sha256').update(String(index)).digest('hex')}${Array.from({ length: 120 }, (_, column) => String.fromCodePoint(0x4e00 + ((index * 131 + column * 317) % 20000))).join('')}🙂\n`
      ).join('')
      assert.ok(
        text.length < 500000,
        'Respect SDK persisted-string ceiling while exercising >1MiB UTF8'
      )
      assert.ok(Buffer.byteLength(text, 'utf8') > 1024 * 1024)
      f.provider.enqueue({ text, textChunkChars: 4096 })
      await first.connection.prompt('Return the supplied unique test payload')
      await first.close()
      const next = await f.open()
      const restored = await recoverRemoteSession(
        next.options({ type: 'resume', reference: created.reference, savedModel: recoveryModel })
      )
      const assistant = restored.messages.find(
        (message) => (message as { role?: string }).role === 'assistant'
      )
      assert.ok(JSON.stringify(assistant).includes('🙂'))
      assert.deepEqual(
        (assistant as { content: Array<{ type: string; text?: string }> }).content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(''),
        text
      )
      assert.equal(f.provider.requests.length, 1)
      assert.equal(
        next.frames.some((frame) => frame.type === 'agent_start'),
        false
      )
    } finally {
      await f.close()
    }
  }
)

test('strict saved-state proof rejects a different journal model before any switch', async () => {
  const f = await unit()
  try {
    await assert.rejects(
      recoverRemoteSession({
        ...f.options,
        verifySavedState: async () => ({ model: replacementModel, modelRole: 'default' })
      }),
      { code: 'MODEL_UNAVAILABLE' }
    )
    assert.equal(
      f.wire.commands.some((command) => command.type === 'switch_session'),
      false
    )
    assert.equal(f.published(), 0)
  } finally {
    await f.connection.close()
  }
})

test('revoked generation fails before attaching observers or issuing commands', async () => {
  const f = await unit()
  await f.connection.close()
  await assert.rejects(recoverRemoteSession(f.options), { code: 'GENERATION_REVOKED' })
  assert.equal(f.published(), 0)
})
