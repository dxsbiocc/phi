import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionVerificationError } from '../src/main/agent/engine/phi-extension/lib/rpc-session-verification-protocol'
import { createSessionVerificationFixture } from './helpers/rpcSessionVerificationFixture'

const signal = (): AbortSignal => new AbortController().signal
const identityMismatch = (error: unknown): boolean =>
  error instanceof SessionVerificationError && error.code === 'IDENTITY_MISMATCH'

for (const action of ['saved', 'checkpoint'] as const) {
  test(
    'real SDK ' + action + ' proof accepts only the actual canonical TMPDIR project identity',
    async (t) => {
      const fixture = await createSessionVerificationFixture(undefined, { isolatedProject: true })
      t.after(() => fixture.close())
      const created = (await fixture.fixtureCommand(
        action === 'saved' ? 'branches' : 'initialize'
      ))!
      const path = created.path as string,
        before = await readFile(path)
      const header = before
        .toString()
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((entry) => entry.type === 'session')
      assert.ok(header)
      assert.equal(await realpath(header.cwd), fixture.identity.projectRoot)
      if (process.platform === 'darwin' && fixture.identity.projectRoot.startsWith('/private/')) {
        assert.equal(header.cwd, fixture.identity.projectRoot.slice('/private'.length))
        assert.notEqual(header.cwd, fixture.identity.projectRoot)
      }
      const proof =
        action === 'saved'
          ? await fixture.verifier.verifySavedState(fixture.reference(created), signal())
          : await fixture.verifier.verifyAttachment(
              {
                phiSessionId: fixture.identity.phiSessionId,
                ompSessionId: created.id as string,
                journalPath: path,
                projectRoot: fixture.identity.projectRoot,
                generation: fixture.identity.generation
              },
              signal()
            )
      assert.equal(proof.projectRoot, fixture.identity.projectRoot)
      assert.equal(proof.ompSessionId, header.id)
      assert.deepEqual(await readFile(path), before)
      assert.equal(fixture.frames.filter((frame) => frame.type === 'agent_start').length, 0)
    }
  )
}

test('real SDK saved proof rejects missing, invalid, different-directory and arbitrary symlink cwd', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const created = (await fixture.fixtureCommand('branches'))!,
    path = created.path as string,
    before = await readFile(path, 'utf8'),
    lines = before.trimEnd().split('\n'),
    entries = lines.map((line) => JSON.parse(line)),
    headerIndex = entries.findIndex((entry) => entry.type === 'session'),
    header = entries[headerIndex],
    other = join(fixture.root, 'other-project'),
    alias = join(fixture.root, 'project-alias'),
    file = join(fixture.root, 'project-file')
  await mkdir(other, { mode: 0o700 })
  await symlink(fixture.identity.projectRoot, alias)
  await writeFile(file, 'not a directory', { mode: 0o600 })
  assert.ok(headerIndex >= 0)
  for (const cwd of [
    undefined,
    null,
    42,
    '',
    'project',
    fixture.identity.projectRoot + '/.',
    fixture.identity.projectRoot + '\u0000',
    '/'.repeat(4097),
    join(fixture.root, 'missing-project'),
    other,
    alias,
    file
  ]) {
    const changedLines = [...lines]
    changedLines[headerIndex] = JSON.stringify({ ...header, cwd })
    const changed = changedLines.join('\n') + '\n'
    await writeFile(path, changed, { mode: 0o600 })
    await assert.rejects(
      fixture.verifier.verifySavedState(fixture.reference(created), signal()),
      identityMismatch
    )
    assert.equal(await readFile(path, 'utf8'), changed)
  }
  await writeFile(path, before, { mode: 0o600 })
  await fixture.verifier.verifySavedState(fixture.reference(created), signal())
})

test('project directory replacement during real artifact verification cannot publish a proof', async (t) => {
  const fixture = await createSessionVerificationFixture()
  t.after(() => fixture.close())
  const created = (await fixture.fixtureCommand('artifact-large'))!,
    before = await readFile(created.path as string)
  await fixture.fixtureCommand('arm-project-replace')
  await assert.rejects(
    fixture.verifier.verifySavedState(fixture.reference(created), signal()),
    identityMismatch
  )
  assert.deepEqual(await readFile(created.path as string), before)
})
