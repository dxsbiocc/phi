import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  readFile,
  writeFile,
  unlink,
  symlink,
  link,
  chmod,
  readdir,
  mkdir,
  rename,
  utimes
} from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionVerificationFixture } from './helpers/rpcSessionVerificationFixture'
import {
  SessionVerificationError,
  SESSION_VERIFICATION_DEFAULT_BUDGETS
} from '../src/main/agent/engine/phi-extension/lib/rpc-session-verification-protocol'

const signal = (): AbortSignal => new AbortController().signal
const code =
  (expected: string): ((error: unknown) => boolean) =>
  (error: unknown) =>
    error instanceof SessionVerificationError && error.code === expected

test('actual local slash command counts as its own admitted submission while outside state is settled', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const before = await fixture.connection.request<Record<string, unknown>>({ type: 'get_state' })
  assert.equal(before.isSettled, true)
  const inside = (await fixture.fixtureCommand('stats'))!
  assert.equal(inside.admitted, true)
  assert.equal(inside.providerCalls, 0)
})

test('production saved proof uses real SDK title, current branch and role restore without touching live state', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  await fixture.fixtureCommand('initialize')
  const live = await fixture.connection.request<Record<string, unknown>>({ type: 'get_state' })
  for (const kind of ['header', 'branches', 'role', 'fallback', 'assistant-fallback', 'unicode']) {
    const created = (await fixture.fixtureCommand(kind))!
    const before = await readFile(created.path as string)
    assert.equal(before[0], 123)
    const proof = await fixture.verifier.verifySavedState(fixture.reference(created), signal())
    assert.equal(
      proof.model === null ? null : proof.model.provider + '/' + proof.model.id,
      created.expectedModel
    )
    assert.equal(proof.ompSessionId, created.id)
    assert.deepEqual(await readFile(created.path as string), before)
    assert.ok(before.byteLength > (kind === 'unicode' ? 1_000_000 : 0))
  }
  const after = await fixture.connection.request<Record<string, unknown>>({ type: 'get_state' })
  assert.equal(after.sessionId, live.sessionId)
  assert.equal(after.sessionFile, live.sessionFile)
  assert.equal(fixture.frames.filter((frame) => frame.type === 'agent_start').length, 0)
})

test('all real SDK persistent image carriers require exact blob bytes; plain prose is not a dependency', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  for (const carrier of ['user', 'tool', 'custom', 'images', 'generation', 'image-url', 'snap']) {
    const created = (await fixture.fixtureCommand(carrier))!
    const reference = fixture.reference(created)
    const raw = await readFile(created.path as string, 'utf8')
    const hashes = [
      ...new Set([...raw.matchAll(/blob:sha256:([0-9a-f]{64})/g)].map((match) => match[1]))
    ]
    assert.equal(hashes.length, 1, carrier + ' must be externalized by SDK serializer')
    const path = join(fixture.identity.blobs, hashes[0]),
      bytes = await readFile(path)
    const proof = await fixture.verifier.verifySavedState(reference, signal())
    assert.equal(proof.blobCount, 1, carrier)
    assert.equal(await readFile(created.path as string, 'utf8'), raw)
    await unlink(path)
    await assert.rejects(
      fixture.verifier.verifySavedState(reference, signal()),
      code('ASSET_MISSING'),
      carrier
    )
    await writeFile(path, Buffer.alloc(bytes.length, 66), { mode: 0o600 })
    await assert.rejects(
      fixture.verifier.verifySavedState(reference, signal()),
      code('FILE_INVALID'),
      carrier
    )
    await writeFile(path, bytes, { mode: 0o600 })
  }
})

test('artifact proof is structured, session-pinned, exact and accepts legal capped output', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  for (const kind of ['artifact', 'artifact-column', 'artifact-source']) {
    const created = (await fixture.fixtureCommand(kind))!
    const ref = fixture.reference(created),
      dir = (created.path as string).slice(0, -6)
    const names = await readdir(dir)
    assert.equal(names.length, 1)
    const path = join(dir, names[0]),
      bytes = await readFile(path)
    assert.equal((await fixture.verifier.verifySavedState(ref, signal())).artifactCount, 1)
    await writeFile(join(dir, names[0].split('.')[0] + '.duplicate'), bytes, { mode: 0o600 })
    await assert.rejects(fixture.verifier.verifySavedState(ref, signal()), code('FILE_INVALID'))
    await unlink(join(dir, names[0].split('.')[0] + '.duplicate'))
    await unlink(path)
    await assert.rejects(fixture.verifier.verifySavedState(ref, signal()), code('ASSET_MISSING'))
    await writeFile(path, bytes, { mode: 0o600 })
  }
  const noArtifacts = (await fixture.fixtureCommand('branches'))!
  await fixture.verifier.verifySavedState(fixture.reference(noArtifacts), signal())
})

test('SDK-lenient malformed records and invalid graphs fail without repairing source', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  for (const kind of ['bad-json', 'duplicate', 'missing-parent', 'cycle', 'header', 'compaction']) {
    const created = (await fixture.fixtureCommand(kind === 'compaction' ? 'snap' : 'branches'))!
    const path = created.path as string,
      lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    const entries = lines.map((line) => JSON.parse(line))
    const last = entries[entries.length - 1]
    if (kind === 'bad-json') lines.splice(3, 0, '{"bad":')
    if (kind === 'duplicate') last.id = entries[2].id
    if (kind === 'missing-parent') last.parentId = 'missing'
    if (kind === 'cycle') last.parentId = last.id
    if (kind === 'header') last.type = 'session'
    if (kind === 'compaction') {
      const index = entries.findIndex((entry) => entry.type === 'compaction')
      assert.ok(index > 0)
      entries[index].firstKeptEntryId = 'missing'
      lines[index] = JSON.stringify(entries[index])
    } else if (kind !== 'bad-json') lines[lines.length - 1] = JSON.stringify(last)
    const corrupt = lines.join('\n') + '\n'
    await writeFile(path, corrupt, { mode: 0o600 })
    await assert.rejects(
      fixture.verifier.verifySavedState(fixture.reference(created), signal()),
      code('FILE_INVALID'),
      kind
    )
    assert.equal(await readFile(path, 'utf8'), corrupt)
  }
})

test('journal/blob symlinks, hardlinks, public modes and nonregular files are rejected', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const created = (await fixture.fixtureCommand('user'))!,
    path = created.path as string
  const raw = await readFile(path, 'utf8'),
    hash = /blob:sha256:([0-9a-f]{64})/.exec(raw)![1]
  const blob = join(fixture.identity.blobs, hash),
    bytes = await readFile(blob),
    elsewhere = join(fixture.root, 'elsewhere')
  await writeFile(elsewhere, bytes, { mode: 0o600 })
  await unlink(blob)
  await symlink(elsewhere, blob)
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), signal()),
    code('FILE_INVALID')
  )
  await unlink(blob)
  await link(elsewhere, blob)
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), signal()),
    code('FILE_INVALID')
  )
  await unlink(blob)
  await writeFile(blob, bytes, { mode: 0o600 })
  await chmod(blob, 0o644)
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), signal()),
    code('FILE_INVALID')
  )
  await unlink(blob)
  await mkdir(blob, { mode: 0o700 })
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), signal()),
    code('FILE_INVALID')
  )
  const moved = path + '.saved'
  await rename(path, moved)
  await symlink(moved, path)
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), signal()),
    code('FILE_INVALID')
  )
})

test('checkpoint proves actual live manager and flushes pending entries without provider execution', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const live = (await fixture.fixtureCommand('initialize'))!
  const identity = {
    phiSessionId: fixture.identity.phiSessionId,
    ompSessionId: live.id as string,
    journalPath: live.path as string,
    projectRoot: fixture.identity.projectRoot,
    generation: 1
  }
  const first = await fixture.verifier.verifyAttachment(identity, signal())
  await fixture.fixtureCommand('live-pending')
  const second = await fixture.verifier.verifyAttachment(identity, signal())
  assert.notEqual(first.leafId, second.leafId)
  assert.match(await readFile(live.path as string, 'utf8'), /pending exact bytes/)
  await assert.rejects(
    fixture.verifier.verifyAttachment({ ...identity, ompSessionId: 'wrong' }, signal()),
    code('IDENTITY_MISMATCH')
  )
  assert.equal(fixture.frames.filter((frame) => frame.type === 'agent_start').length, 0)
})

test('actual production command accepts exact journal byte budget and fails one byte below it', async (t) => {
  const baseline = await createSessionVerificationFixture()
  t.after(() => baseline.close())
  const initial = (await baseline.fixtureCommand('header'))!
  const length = (await readFile(initial.path as string)).byteLength
  const exact = await createSessionVerificationFixture({
    ...SESSION_VERIFICATION_DEFAULT_BUDGETS,
    journalBytes: length
  })
  t.after(() => exact.close())
  const target = (await exact.fixtureCommand('header'))!
  assert.equal((await readFile(target.path as string)).byteLength, length)
  await exact.verifier.verifySavedState(exact.reference(target), signal())
  const limited = await createSessionVerificationFixture({
    ...SESSION_VERIFICATION_DEFAULT_BUDGETS,
    journalBytes: length - 1
  })
  t.after(() => limited.close())
  const over = (await limited.fixtureCommand('header'))!
  assert.equal((await readFile(over.path as string)).byteLength, length)
  await assert.rejects(
    limited.verifier.verifySavedState(limited.reference(over), signal()),
    code('VERIFICATION_LIMIT')
  )
})

test('revoked production capability and deleted target fail closed without minting a new journal', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const created = (await fixture.fixtureCommand('branches'))!,
    ref = fixture.reference(created)
  await unlink(created.path as string)
  const before = await readdir(fixture.identity.journals)
  await assert.rejects(fixture.verifier.verifySavedState(ref, signal()), code('FILE_INVALID'))
  assert.deepEqual(await readdir(fixture.identity.journals), before)
  await fixture.fixtureCommand('revoke')
  await assert.rejects(fixture.verifier.verifySavedState(ref, signal()), code('GENERATION_REVOKED'))
})

test('production cancellation during bounded streaming artifact inspection never returns a partial proof', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const created = (await fixture.fixtureCommand('artifact-large'))!
  const before = await readFile(created.path as string)
  await fixture.fixtureCommand('arm-revoke')
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), signal()),
    code('GENERATION_REVOKED')
  )
  assert.deepEqual(await readFile(created.path as string), before)
})

test('invalid UTF-8 that the SDK text decoder could replace is rejected before inspection', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const created = (await fixture.fixtureCommand('branches'))!,
    path = created.path as string
  const raw = await readFile(path)
  const marker = raw.indexOf(Buffer.from('A normal'))
  assert.ok(marker > 0)
  raw[marker] = 0xff
  await writeFile(path, raw, { mode: 0o600 })
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), signal()),
    code('FILE_INVALID')
  )
  assert.deepEqual(await readFile(path), raw)
})

test('checkpoint propagates real live session flush failure instead of proving a stale journal', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const live = (await fixture.fixtureCommand('initialize'))!
  await fixture.fixtureCommand('live-fail-flush')
  await assert.rejects(
    fixture.verifier.verifyAttachment(
      {
        phiSessionId: fixture.identity.phiSessionId,
        ompSessionId: live.id as string,
        journalPath: live.path as string,
        projectRoot: fixture.identity.projectRoot,
        generation: 1
      },
      signal()
    ),
    code('PERSISTENCE_FAILED')
  )
})

test('saved asset baseline binds first attachment, commits explicitly and permits later legitimate assets', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const created = (await fixture.fixtureCommand('artifact'))!,
    reference = fixture.reference(created),
    verifier = fixture.verifier
  await verifier.verifySavedState(reference, signal())
  await fixture.connection.request({ type: 'switch_session', sessionPath: created.path })
  const target = {
    phiSessionId: fixture.identity.phiSessionId,
    ompSessionId: created.id as string,
    journalPath: created.path as string,
    projectRoot: fixture.identity.projectRoot,
    generation: 1
  }
  const first = await verifier.verifyAttachment(target, signal())
  verifier.commitAttachment()
  await fixture.fixtureCommand('live-add-artifact')
  const after = await verifier.verifyAttachment(target, signal())
  assert.equal(after.artifactCount, first.artifactCount + 1)
  verifier.commitAttachment()
})

test('artifact content replacement after saved proof faults attachment and cannot consume or replace baseline', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const created = (await fixture.fixtureCommand('artifact'))!,
    ref = fixture.reference(created),
    verifier = fixture.verifier
  await verifier.verifySavedState(ref, signal())
  const dir = (created.path as string).slice(0, -6),
    names = await readdir(dir)
  await writeFile(join(dir, names[0]), 'different artifact content', { mode: 0o600 })
  await fixture.connection.request({ type: 'switch_session', sessionPath: created.path })
  await assert.rejects(
    verifier.verifyAttachment(
      {
        phiSessionId: fixture.identity.phiSessionId,
        ompSessionId: created.id as string,
        journalPath: created.path as string,
        projectRoot: fixture.identity.projectRoot,
        generation: 1
      },
      signal()
    ),
    code('FILE_INVALID')
  )
  assert.throws(() => verifier.commitAttachment(), code('GENERATION_REVOKED'))
  await assert.rejects(verifier.verifySavedState(ref, signal()), code('GENERATION_REVOKED'))
})

test('metadata-only blob touch between saved proof and switch retains exact content baseline', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const created = (await fixture.fixtureCommand('user'))!,
    ref = fixture.reference(created),
    verifier = fixture.verifier
  await verifier.verifySavedState(ref, signal())
  const hash = /blob:sha256:([0-9a-f]{64})/.exec(await readFile(created.path as string, 'utf8'))![1]
  await utimes(join(fixture.identity.blobs, hash), new Date(0), new Date(0))
  await fixture.connection.request({ type: 'switch_session', sessionPath: created.path })
  await verifier.verifyAttachment(
    {
      phiSessionId: fixture.identity.phiSessionId,
      ompSessionId: created.id as string,
      journalPath: created.path as string,
      projectRoot: fixture.identity.projectRoot,
      generation: 1
    },
    signal()
  )
  verifier.commitAttachment()
})

test('SDK hydration work has an independent exact expanded-byte budget before open', async (t) => {
  const work = 100_000 + Math.ceil(100_000 / 3) * 8
  for (const [budget, passes] of [
    [work, true],
    [work - 1, false]
  ] as const) {
    const fixture = await createSessionVerificationFixture({
      ...SESSION_VERIFICATION_DEFAULT_BUDGETS,
      hydratedBytes: budget
    })
    t.after(() => fixture.close())
    const created = (await fixture.fixtureCommand('user'))!,
      bytes = await readFile(created.path as string)
    if (passes) await fixture.verifier.verifySavedState(fixture.reference(created), signal())
    else
      await assert.rejects(
        fixture.verifier.verifySavedState(fixture.reference(created), signal()),
        code('VERIFICATION_LIMIT')
      )
    assert.deepEqual(await readFile(created.path as string), bytes)
  }
})

test('actual native Bash spill metadata is verified with its real session artifact and no provider turn', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const live = (await fixture.fixtureCommand('initialize'))!
  await fixture.fixtureCommand('native-spill')
  const raw = await readFile(live.path as string, 'utf8')
  assert.match(raw, /"artifactId":"[0-9]+"/)
  const target = {
    phiSessionId: fixture.identity.phiSessionId,
    ompSessionId: live.id as string,
    journalPath: live.path as string,
    projectRoot: fixture.identity.projectRoot,
    generation: 1
  }
  const proof = await fixture.verifier.verifyAttachment(target, signal())
  assert.ok(proof.artifactCount > 0)
  const dir = (live.path as string).slice(0, -6),
    names = await readdir(dir)
  assert.ok(names.length > 0)
  await unlink(join(dir, names[0]))
  await assert.rejects(fixture.verifier.verifyAttachment(target, signal()), code('ASSET_MISSING'))
  assert.equal(fixture.frames.filter((frame) => frame.type === 'agent_start').length, 0)
})

test('artifact symlink and hardlink cannot borrow another session or external file authority', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const created = (await fixture.fixtureCommand('artifact'))!,
    dir = (created.path as string).slice(0, -6)
  const name = (await readdir(dir))[0],
    path = join(dir, name),
    bytes = await readFile(path),
    external = join(fixture.root, 'other-artifact')
  await writeFile(external, bytes, { mode: 0o600 })
  await unlink(path)
  await symlink(external, path)
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), signal()),
    code('FILE_INVALID')
  )
  await unlink(path)
  await link(external, path)
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), signal()),
    code('FILE_INVALID')
  )
})

for (const action of ['arm-leaf', 'arm-rebind']) {
  test('actual live manager change during streaming proof fails closed: ' + action, async (t) => {
    const fixture = await createSessionVerificationFixture()
    t.after(() => fixture.close())
    const created = (await fixture.fixtureCommand('artifact-large'))!
    await fixture.connection.request({ type: 'switch_session', sessionPath: created.path })
    if (action === 'arm-rebind') await fixture.fixtureCommand('header')
    await fixture.fixtureCommand(action)
    await assert.rejects(
      fixture.verifier.verifyAttachment(
        {
          phiSessionId: fixture.identity.phiSessionId,
          ompSessionId: created.id as string,
          journalPath: created.path as string,
          projectRoot: fixture.identity.projectRoot,
          generation: 1
        },
        signal()
      ),
      code('IDENTITY_MISMATCH')
    )
  })
}
