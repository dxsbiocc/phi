import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { SessionVerificationError } from '../src/main/agent/engine/phi-extension/lib/rpc-session-verification-protocol'
import { createSessionVerificationFixture } from './helpers/rpcSessionVerificationFixture'

const signal = (): AbortSignal => new AbortController().signal
const code =
  (expected: string): ((error: unknown) => boolean) =>
  (error: unknown) =>
    error instanceof SessionVerificationError && error.code === expected

test('late real checkpoint leaf change after intermediate manager validation cannot publish the old proof leaf', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const created = (await fixture.fixtureCommand('artifact-large'))!
  await fixture.connection.request({ type: 'switch_session', sessionPath: created.path })
  const target = {
    phiSessionId: fixture.identity.phiSessionId,
    ompSessionId: created.id as string,
    journalPath: created.path as string,
    projectRoot: fixture.identity.projectRoot,
    generation: 1
  }
  const before = (await fixture.fixtureCommand('stats'))!.checks as number
  const initial = await fixture.verifier.verifyAttachment(target, signal())
  const after = (await fixture.fixtureCommand('stats'))!.checks as number
  const total = after - before
  assert.ok(total > 150, 'large real artifact must exercise both streaming verification passes')
  // For this one-chunk journal the post-asset tail has fewer than 20 checks.
  // Calibrate with the same production command, then mutate during the second
  // large artifact read, after both intermediate verifyManager calls.
  await fixture.fixtureCommand('arm-leaf-late ' + (total - 20))
  await assert.rejects(
    fixture.verifier.verifyAttachment(target, signal()),
    code('IDENTITY_MISMATCH')
  )
  const actual = await fixture.connection.request<Record<string, unknown>>({ type: 'get_entries' })
  assert.equal(typeof actual.leafId, 'string')
  assert.ok(Array.isArray(actual.entries))
  assert.equal(actual.leafId, actual.entries[0].id)
  assert.notEqual(actual.leafId, initial.leafId)
})

for (const kind of ['native-compaction', 'native-compaction-replay']) {
  test(
    'actual SDK native full-prefix compaction preserves valid empty boundary: ' + kind,
    async (t) => {
      const fixture = await createSessionVerificationFixture()
      t.after(() => fixture.close())
      const created = (await fixture.fixtureCommand(kind))!
      const bytes = await readFile(created.path as string)
      assert.match(bytes.toString(), /"firstKeptEntryId":""/)
      assert.match(bytes.toString(), /"anthropicCompaction"/)
      assert.match(bytes.toString(), /exact-native-signature/)
      const proof = await fixture.verifier.verifySavedState(fixture.reference(created), signal())
      assert.equal(proof.model?.provider + '/' + proof.model?.id, created.expectedModel)
      assert.deepEqual(await readFile(created.path as string), bytes)
    }
  )
}

for (const corruption of [
  'ordinary-empty',
  'missing-provider',
  'empty-content',
  'bad-signature',
  'bad-retained-files',
  'bad-replay',
  'off-branch-replay'
]) {
  test(
    'empty compaction boundary never hides malformed native payload or replay ancestry: ' +
      corruption,
    async (t) => {
      const fixture = await createSessionVerificationFixture()
      t.after(() => fixture.close())
      const created = (await fixture.fixtureCommand('native-compaction-replay'))!,
        path = created.path as string
      const lines = (await readFile(path, 'utf8')).trimEnd().split('\n'),
        entries = lines.map((line) => JSON.parse(line))
      const index = entries.findIndex((entry) => entry.type === 'compaction'),
        entry = entries[index]
      assert.ok(index > 0)
      if (corruption === 'ordinary-empty') delete entry.preserveData.anthropicCompaction
      if (corruption === 'missing-provider') delete entry.preserveData.anthropicCompaction.provider
      if (corruption === 'empty-content') entry.preserveData.anthropicCompaction.content = ''
      if (corruption === 'bad-signature') entry.preserveData.anthropicCompaction.signature = 42
      if (corruption === 'bad-retained-files')
        entry.preserveData.anthropicCompaction.retainedFiles = [
          { text: 'bad', after: 'not-a-number' }
        ]
      if (corruption === 'bad-replay') entry.providerReplayThroughEntryId = 'missing'
      if (corruption === 'off-branch-replay') {
        const discarded = entries.find(
          (candidate) =>
            candidate.type === 'model_change' && candidate.model === 'fixture/discarded'
        )
        assert.ok(discarded)
        entry.providerReplayThroughEntryId = discarded.id
      }
      lines[index] = JSON.stringify(entry)
      const changed = lines.join('\n') + '\n'
      await writeFile(path, changed, { mode: 0o600 })
      await assert.rejects(
        fixture.verifier.verifySavedState(fixture.reference(created), signal()),
        code('FILE_INVALID')
      )
      assert.equal(await readFile(path, 'utf8'), changed)
    }
  )
}
