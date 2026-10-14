import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { shellQuote as q } from '../src/main/agent/wrappers/remote-ssh-session'
import {
  deriveRemoteSessionPaths,
  remoteJournalPath
} from '../src/main/agent/engine/rpc/session-storage/paths'
import { preflightRemoteJournal } from '../src/main/agent/engine/rpc/session-storage/remote-preflight'
import { prepareRemoteSessionStorage } from '../src/main/agent/engine/rpc/session-storage/writer-lease'
import {
  createRemoteSessionStorageFixture,
  prepareRemoteSessionStorageFixture as prepared
} from './helpers/remoteSessionStorageFixture'
import { createSessionVerificationFixture } from './helpers/rpcSessionVerificationFixture'

const hasCode =
  (expected: string) =>
  (error: unknown): boolean =>
    error instanceof Error && 'code' in error && error.code === expected
const macOnly = { skip: process.platform !== 'darwin' }

async function actualNativeFixture(
  t: TestContext,
  signal?: AbortSignal
): Promise<
  Awaited<ReturnType<typeof createRemoteSessionStorageFixture>> & {
    preparation: Awaited<ReturnType<typeof prepareRemoteSessionStorage>>
    bytes: Buffer
    lines: string[]
    index: number
    header: { cwd: string }
  }
> {
  const sdk = await createSessionVerificationFixture(undefined, { isolatedProject: true })
  t.after(() => sdk.close())
  const f = await createRemoteSessionStorageFixture()
  t.after(f.cleanup)
  const created = (await sdk.fixtureCommand('branches'))!
  const bytes = await readFile(created.path as string)
  const scope = { ...f.scope, projectRoot: sdk.identity.projectRoot }
  const paths = deriveRemoteSessionPaths(scope)
  const reference = {
    ...f.reference,
    ...scope,
    ompSessionId: created.id as string,
    journalBasename: basename(created.path as string),
    durableSessionKey: paths.durableSessionKey
  }
  const preparation = await prepareRemoteSessionStorage({ ...f.options, scope, signal })
  t.after(() => preparation.lease.release())
  const journalPath = remoteJournalPath(scope, reference)
  await writeFile(journalPath, bytes, { mode: 0o600 })
  const lines = bytes.toString().trimEnd().split('\n')
  const index = lines.findIndex((line) => JSON.parse(line).type === 'session')
  assert.ok(index >= 0)
  const header = JSON.parse(lines[index])
  assert.equal(header.cwd, scope.projectRoot.slice('/private'.length))
  assert.notEqual(header.cwd, scope.projectRoot)
  return { ...f, preparation, reference, scope, paths, journalPath, bytes, lines, index, header }
}

test(
  'actual native macOS alias passes Node remote preflight with unchanged raw header hashes',
  macOnly,
  async (t) => {
    const f = await actualNativeFixture(t)
    const run = f.host.exec.run
    const outputs: string[] = []
    const commands: string[] = []
    f.host.exec.run = async (command, options) => {
      const result = await run(command, options)
      commands.push(command[2] ?? '')
      outputs.push(result.stdout)
      return result
    }
    const proof = await preflightRemoteJournal(f.preparation, f.reference)
    assert.equal(proof.cwd, f.scope.projectRoot)
    assert.equal(proof.ompSessionId, f.reference.ompSessionId)
    assert.equal(commands.length, 2)
    assert.ok(commands[1].includes('uname -s'))
    const metadata = outputs[0].slice(0, outputs[0].indexOf('\n'))
    const rawHeader = Buffer.from(f.lines[f.index])
    const prefix = Buffer.from(f.lines.slice(0, f.index + 1).join('\n') + '\n')
    assert.equal(
      proof.fileIdentity,
      createHash('sha256')
        .update(metadata.split(':').slice(0, 2).join(':'))
        .update('\0')
        .update(rawHeader)
        .digest('hex')
    )
    assert.equal(
      proof.fingerprint,
      createHash('sha256').update(metadata).update('\0').update(prefix).digest('hex')
    )
    assert.deepEqual(await readFile(f.journalPath), f.bytes)
  }
)

test('canonical Node preflight keeps its original one-operation path', async (t) => {
  const f = await prepared(t)
  await f.writeJournal()
  const run = f.host.exec.run
  let calls = 0
  f.host.exec.run = async (...args) => {
    calls++
    return run(...args)
  }
  assert.equal((await preflightRemoteJournal(f.preparation, f.reference)).cwd, f.scope.projectRoot)
  assert.equal(calls, 1)
})

test(
  'remote alias preflight rejects invalid cwd, arbitrary symlinks and a different project',
  macOnly,
  async (t) => {
    const f = await actualNativeFixture(t)
    const alias = join(f.root, 'arbitrary-project-alias'),
      other = join(f.root, 'other-project')
    await symlink(f.scope.projectRoot, alias)
    await mkdir(other, { mode: 0o700 })
    for (const cwd of [
      '',
      'relative',
      f.header.cwd + '/.',
      f.header.cwd + '\u0000',
      join(f.root, 'missing'),
      alias,
      other
    ]) {
      const changed = [...f.lines]
      changed[f.index] = JSON.stringify({ ...f.header, cwd })
      await writeFile(f.journalPath, changed.join('\n') + '\n', { mode: 0o600 })
      await assert.rejects(
        preflightRemoteJournal(f.preparation, f.reference),
        hasCode('IDENTITY_MISMATCH')
      )
    }
  }
)

test(
  'alias permission requires the remote command platform rather than Node platform',
  macOnly,
  async (t) => {
    const f = await actualNativeFixture(t)
    const run = f.host.exec.run
    let probed = false
    f.host.exec.run = (command, options) => {
      if (command[2]?.includes('storage_project_identity()')) {
        probed = true
        return run(['sh', '-c', `uname() { printf 'Linux\\n'; }\n${command[2]}`], options)
      }
      return run(command, options)
    }
    await assert.rejects(
      preflightRemoteJournal(f.preparation, f.reference),
      hasCode('IDENTITY_MISMATCH')
    )
    assert.equal(probed, true)
  }
)

for (const target of ['project', 'journal'] as const) {
  test(
    'actual ' + target + ' replacement inside remote alias probe rejects the previous identity',
    macOnly,
    async (t) => {
      const f = await actualNativeFixture(t)
      const run = f.host.exec.run
      const moved = f.scope.projectRoot + '.replaced'
      const marker = join(f.root, 'replaced-once')
      const projectBefore = await lstat(f.scope.projectRoot)
      const journalBefore = await lstat(f.journalPath)
      const mutation =
        target === 'project'
          ? `mv -- ${q(f.scope.projectRoot)} ${q(moved)}; mkdir -m 700 -- ${q(f.scope.projectRoot)}`
          : `mv -- ${q(f.journalPath)} ${q(f.journalPath + '.saved')}; cp -p -- ${q(f.journalPath + '.saved')} ${q(f.journalPath)}`
      f.host.exec.run = (command, options) => {
        if (!command[2]?.includes('storage_project_identity()')) return run(command, options)
        return run(
          [
            'sh',
            '-c',
            `stat() {
  if [ "$1" = -f ] && [ "$2" = '%d:%i' ] && [ "$3" = ${q(f.scope.projectRoot)} ] && [ ! -e ${q(marker)} ]; then
    command stat "$@" || return
    : > ${q(marker)}
    ${mutation}
  else command stat "$@"; fi
}\n${command[2]}`
          ],
          options
        )
      }
      try {
        await assert.rejects(
          preflightRemoteJournal(f.preparation, f.reference),
          hasCode(target === 'project' ? 'IDENTITY_MISMATCH' : 'FILE_INVALID')
        )
        const after = await lstat(target === 'project' ? f.scope.projectRoot : f.journalPath)
        assert.notEqual(after.ino, target === 'project' ? projectBefore.ino : journalBefore.ino)
        assert.deepEqual(await readFile(f.journalPath), f.bytes)
      } finally {
        if (target === 'project') {
          await rm(f.scope.projectRoot, { recursive: true, force: true })
          await rename(moved, f.scope.projectRoot)
        }
      }
    }
  )
}

test(
  'same-inode raw header replacement cannot hide behind unchanged remote metadata',
  { ...macOnly, timeout: 30000 },
  async (t) => {
    const f = await actualNativeFixture(t)
    const run = f.host.exec.run
    const metadataTrace = join(f.root, 'actual-metadata-trace')
    const windowStarted = join(f.root, 'actual-window-started')
    const before = await lstat(f.journalPath)
    const offset = f.bytes.indexOf(Buffer.from(f.reference.ompSessionId))
    assert.ok(offset > 0)
    let metadata: string | undefined
    // Prepare both scripts before entering the real remote clock window.
    const initialStat = `stat() {
  if [ "$1" = -f ] && [ "$2" = '%d:%i:%z:%m:%c' ] && [ "$3" = ${q(f.journalPath)} ]; then
    if [ ! -e ${q(windowStarted)} ]; then
      : > ${q(windowStarted)}
      initial_second=$(date +%s)
      while [ "$(date +%s)" = "$initial_second" ]; do sleep 0.01; done
      touch ${q(f.journalPath)}
    fi
  fi
  command stat "$@"
}`
    const overwrite = `printf X | dd of=${q(f.journalPath)} bs=1 seek=${offset} conv=notrunc 2>/dev/null
command stat -f '%d:%i:%z:%m:%c' ${q(f.journalPath)} >> ${q(metadataTrace)}`
    const aliasStat = `stat() {
  if [ "$1" = -f ] && [ "$2" = '%d:%i:%z:%m:%c' ] && [ "$3" = ${q(f.journalPath)} ]; then
    actual_metadata=$(command stat "$@") || return
    printf '%s\\n' "$actual_metadata"
    printf '%s\\n' "$actual_metadata" >> ${q(metadataTrace)}
  else command stat "$@"; fi
}`
    f.host.exec.run = async (command, options) => {
      if (!command[2]?.includes('storage_project_identity()')) {
        // Capture the original prefix, then mutate before this same shell exits.
        // A slow second RPC cannot move the already completed overwrite to a later second.
        const result = await run(
          ['sh', '-c', `${initialStat}\n${command[2]}\n${overwrite}`],
          options
        )
        metadata = result.stdout.slice(0, result.stdout.indexOf('\n'))
        return result
      }
      assert.ok(metadata)
      return run(['sh', '-c', `${aliasStat}\n${command[2]}`], options)
    }
    const attempts = 3
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await writeFile(f.journalPath, f.bytes)
      for (const path of [metadataTrace, windowStarted]) await rm(path, { force: true })
      let failure: unknown
      try {
        await preflightRemoteJournal(f.preparation, f.reference)
      } catch (error) {
        failure = error
      }
      const actualMetadata = (await readFile(metadataTrace, 'utf8')).trimEnd().split('\n')
      assert.ok(actualMetadata.length >= 2, 'Observe actual post-write and alias-probe metadata')
      const after = await lstat(f.journalPath)
      assert.equal(after.ino, before.ino)
      assert.equal(after.size, before.size)
      assert.notDeepEqual(await readFile(f.journalPath), f.bytes)
      const windowMatched = actualMetadata.every((value) => value === metadata)
      t.diagnostic(
        JSON.stringify({
          attempt,
          before: metadata,
          actualProbeMetadata: actualMetadata,
          windowMatched
        })
      )
      assert.ok(hasCode('FILE_INVALID')(failure), 'Every actual raw header change must fail')
      if (windowMatched) {
        assert.deepEqual(
          actualMetadata,
          actualMetadata.map(() => metadata)
        )
        return
      }
    }
    assert.fail(`No actual equal-metadata overwrite window was observed in ${attempts} attempts`)
  }
)

test(
  'cancelled remote alias proof cannot publish after actual validation acknowledgement arrives late',
  { ...macOnly, timeout: 20000 },
  async (t) => {
    const controller = new AbortController()
    const f = await actualNativeFixture(t, controller.signal)
    const run = f.host.exec.run
    let release!: () => void, enter!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    let remoteDone: Promise<unknown> | undefined
    f.host.exec.run = async (command, options) => {
      if (!command[2]?.includes('storage_project_identity()')) return run(command, options)
      const executed = await run(command, { ...options, signal: undefined })
      assert.equal(executed.code, 0)
      enter()
      remoteDone = gate
      await gate
      return executed
    }
    const pending = preflightRemoteJournal(f.preparation, f.reference)
    void pending.catch(() => undefined)
    try {
      await entered
      const rejected = assert.rejects(
        pending,
        (error: unknown) => error === controller.signal.reason
      )
      controller.abort()
      await rejected
    } finally {
      release()
      await remoteDone
      controller.abort()
    }
  }
)
