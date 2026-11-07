import assert from 'node:assert/strict'
import { readFile, readdir, unlink, writeFile, rename, symlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionVerificationError } from '../src/main/agent/engine/phi-extension/lib/rpc-session-verification-protocol'
import { createSessionShakeFixture } from './helpers/rpcSessionShakeFixture'
import { collectSessionAssetReferences } from '../src/main/agent/engine/phi-extension/lib/rpc-session-assets'
import { SESSION_VERIFICATION_DEFAULT_BUDGETS } from '../src/main/agent/engine/phi-extension/lib/rpc-session-verification-protocol'

const signal = (): AbortSignal => new AbortController().signal
const code =
  (expected: string): ((error: unknown) => boolean) =>
  (error: unknown) =>
    error instanceof SessionVerificationError && error.code === expected

test('actual SDK default-shake artifact deletion is a saved-state failure', async (t) => {
  const fixture = await createSessionShakeFixture()
  t.after(() => fixture.close())
  const created = await fixture.create()
  assert.equal(created.protectTokens, 16000)
  assert.equal(created.minSavings, 4000)
  const raw = await readFile(created.path as string, 'utf8')
  assert.match(raw, /"prunedAt":[0-9]+/)
  assert.match(raw, /\[shaken ~[0-9]+ tokens — recover: artifact:\/\/[0-9]+ \(region 1\)\]/)
  const directory = (created.path as string).slice(0, -6)
  const names = await readdir(directory)
  assert.ok(names.includes(String(created.artifactId) + '.shake.log'))
  const artifact = join(directory, String(created.artifactId) + '.shake.log')
  assert.match(
    await readFile(artifact, 'utf8'),
    /^### region 1 \(shake_fixture, ~[0-9]+ tok\)\n\nfirst durable shake region exact line/m
  )
  await unlink(artifact)
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), new AbortController().signal),
    (error: unknown) => error instanceof SessionVerificationError && error.code === 'ASSET_MISSING'
  )
})

test('actual default-shake regions are included in content inventory and valid read-only checkpoint', async (t) => {
  const fixture = await createSessionShakeFixture()
  t.after(() => fixture.close())
  const created = await fixture.create(),
    path = created.path as string,
    before = await readFile(path)
  const verifier = fixture.verifier
  const saved = await verifier.verifySavedState(fixture.reference(created), signal())
  assert.equal(saved.artifactCount, 1)
  const attached = await verifier.verifyAttachment(
    {
      phiSessionId: fixture.identity.phiSessionId,
      ompSessionId: created.id as string,
      journalPath: path,
      projectRoot: fixture.identity.projectRoot,
      generation: 1
    },
    signal()
  )
  assert.equal(attached.assetDigest, saved.assetDigest)
  verifier.commitAttachment()
  assert.deepEqual(await readFile(path), before)
  assert.equal(fixture.frames.filter((frame) => frame.type === 'agent_start').length, 0)
})

test('ordinary URI prose, unmarked exact text and user text do not confer shake artifact authority', async (t) => {
  const fixture = await createSessionShakeFixture()
  t.after(() => fixture.close())
  const created = await fixture.create(),
    path = created.path as string,
    original = await readFile(path, 'utf8')
  await unlink(join(path.slice(0, -6), String(created.artifactId) + '.shake.log'))
  for (const mode of ['no-flag', 'user-role', 'prose']) {
    const entries = original
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    for (const entry of entries) {
      const message = entry.message
      if (message?.role !== 'toolResult') continue
      if (mode === 'no-flag') delete message.prunedAt
      if (mode === 'user-role') message.role = 'user'
      if (mode === 'prose')
        message.content = [
          {
            type: 'text',
            text: 'This natural explanation mentions artifact://999 and blob:sha256:fake.'
          }
        ]
    }
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', {
      mode: 0o600
    })
    const proof = await fixture.verifier.verifySavedState(fixture.reference(created), signal())
    assert.equal(proof.artifactCount, 0, mode)
  }
})

test('marked malformed grammar, invalid flags and invalid actual region metadata fail explicitly', async (t) => {
  const fixture = await createSessionShakeFixture()
  t.after(() => fixture.close())
  const created = await fixture.create(),
    path = created.path as string,
    original = await readFile(path, 'utf8')
  for (const mode of [
    'region-zero',
    'region-missing',
    'region-unknown',
    'tokens-mismatch',
    'tool-mismatch',
    'bad-uri',
    'invalid-flag',
    'negative-flag',
    'string-content',
    'extra-text'
  ]) {
    const entries = original
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    const message = entries.find((entry) => entry.message?.role === 'toolResult').message
    const text = message.content[0].text as string
    if (mode === 'region-zero') message.content[0].text = text.replace('(region 1)', '(region 0)')
    if (mode === 'region-missing') message.content[0].text = text.replace('(region 1)', '(region )')
    if (mode === 'region-unknown')
      message.content[0].text = text.replace('(region 1)', '(region 999)')
    if (mode === 'tokens-mismatch')
      message.content[0].text = text.replace(
        /~([0-9]+) tokens/,
        (_match: string, tokens: string) => '~' + (Number(tokens) + 1) + ' tokens'
      )
    if (mode === 'tool-mismatch') message.toolName = 'different_tool'
    if (mode === 'bad-uri') message.content[0].text = text.replace('artifact://', 'artifact://../')
    if (mode === 'invalid-flag') message.prunedAt = 'not-a-timestamp'
    if (mode === 'negative-flag') message.prunedAt = -1
    if (mode === 'string-content') message.content = text
    if (mode === 'extra-text')
      message.content.push({ type: 'text', text: 'extra malformed machine text' })
    const changed = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    await writeFile(path, changed, { mode: 0o600 })
    await assert.rejects(
      fixture.verifier.verifySavedState(fixture.reference(created), signal()),
      code('FILE_INVALID'),
      mode
    )
    assert.equal(await readFile(path, 'utf8'), changed)
  }
})

test('same artifact id in another actual SDK session cannot satisfy a missing shake region', async (t) => {
  const fixture = await createSessionShakeFixture()
  t.after(() => fixture.close())
  const first = await fixture.create(),
    second = await fixture.create()
  assert.equal(first.artifactId, second.artifactId)
  assert.notEqual(first.path, second.path)
  const secondArtifact = join(
    (second.path as string).slice(0, -6),
    String(second.artifactId) + '.shake.log'
  )
  assert.match(await readFile(secondArtifact, 'utf8'), /### region 1/)
  await unlink(join((first.path as string).slice(0, -6), String(first.artifactId) + '.shake.log'))
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(first), signal()),
    code('ASSET_MISSING')
  )
})

test('shake region headers require the exact SDK container and blank-line boundary', async (t) => {
  const fixture = await createSessionShakeFixture()
  t.after(() => fixture.close())
  const created = await fixture.create(),
    artifact = join(
      (created.path as string).slice(0, -6),
      String(created.artifactId) + '.shake.log'
    )
  const original = await readFile(artifact, 'utf8')
  for (const invalid of [
    original.replace('### region 1', '### region 0'),
    original.replace('\n\n', '\n'),
    'ordinary prose\n' + original
  ]) {
    await writeFile(artifact, invalid, { mode: 0o600 })
    await assert.rejects(
      fixture.verifier.verifySavedState(fixture.reference(created), signal()),
      code('FILE_INVALID')
    )
  }
})

test('actual shake artifact requires the exact private regular file and canonical SDK filename', async (t) => {
  const fixture = await createSessionShakeFixture()
  t.after(() => fixture.close())
  const created = await fixture.create(),
    path = created.path as string,
    artifact = join(path.slice(0, -6), String(created.artifactId) + '.shake.log')
  const bytes = await readFile(artifact),
    external = join(fixture.root, 'external-shake')
  await writeFile(external, bytes, { mode: 0o600 })
  await unlink(artifact)
  await symlink(external, artifact)
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), signal()),
    code('FILE_INVALID')
  )
  await unlink(artifact)
  await link(external, artifact)
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), signal()),
    code('FILE_INVALID')
  )
  await unlink(artifact)
  await writeFile(artifact, bytes, { mode: 0o600 })
  await rename(artifact, artifact.replace('.shake.log', '.other.log'))
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), signal()),
    code('FILE_INVALID')
  )
})

test('after-proof shake content replacement breaks attachment baseline; pre-proof valid-shape tamper has no historical SHA', async (t) => {
  const fixture = await createSessionShakeFixture()
  t.after(() => fixture.close())
  const created = await fixture.create(),
    path = created.path as string,
    artifact = join(path.slice(0, -6), String(created.artifactId) + '.shake.log')
  const original = await readFile(artifact, 'utf8')
  // Pinned SDK does not persist an expected content hash. Exact headers and a
  // legal body changed before the first proof cannot be authenticated as old bytes.
  await writeFile(
    artifact,
    original.replaceAll('durable shake region exact line', 'different shape-valid artifact body'),
    { mode: 0o600 }
  )
  const verifier = fixture.verifier
  await verifier.verifySavedState(fixture.reference(created), signal())
  await writeFile(artifact, original, { mode: 0o600 })
  await assert.rejects(
    verifier.verifyAttachment(
      {
        phiSessionId: fixture.identity.phiSessionId,
        ompSessionId: created.id as string,
        journalPath: path,
        projectRoot: fixture.identity.projectRoot,
        generation: 1
      },
      signal()
    ),
    code('FILE_INVALID')
  )
  assert.throws(() => verifier.commitAttachment(), code('GENERATION_REVOKED'))
})

test('shake references consume the existing reference budget without relaxing work limits', async (t) => {
  const fixture = await createSessionShakeFixture()
  t.after(() => fixture.close())
  const created = await fixture.create()
  const entries = (await readFile(created.path as string, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  const capability = {
    ...fixture.identity,
    signal: signal(),
    assertActive: () => undefined,
    budgets: { ...SESSION_VERIFICATION_DEFAULT_BUDGETS, references: 1 }
  }
  assert.throws(
    () => collectSessionAssetReferences(entries, capability),
    code('VERIFICATION_LIMIT')
  )
})

test('actual default-shake long artifact lines and headers split across hash chunks retain complete validation', async (t) => {
  const fixture = await createSessionShakeFixture()
  t.after(() => fixture.close())
  const created = await fixture.create('long-line'),
    artifact = join(
      (created.path as string).slice(0, -6),
      String(created.artifactId) + '.shake.log'
    )
  const bytes = await readFile(artifact),
    second = bytes.indexOf(Buffer.from('### region 2'))
  assert.ok(second > 128 * 1024 - 128)
  const end = bytes.indexOf(10, second)
  assert.notEqual(
    Math.floor(second / 65536),
    Math.floor((end - 1) / 65536),
    'SDK second region header must straddle a real hash chunk boundary'
  )
  const proof = await fixture.verifier.verifySavedState(fixture.reference(created), signal())
  assert.equal(proof.artifactCount, 1)
})
