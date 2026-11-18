import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { tryAcquireAssistantInboxWriter } from '../src/main/session-runtime/assistant-inbox-writer'

const lockFile = 'assistant-inbox-writer.sqlite'
const source = new URL('../src/main/session-runtime/assistant-inbox-writer.ts', import.meta.url)
const loader = fileURLToPath(new URL('../scripts/test-loader.mjs', import.meta.url))
type WriterChild = { child: ChildProcess; exit: Promise<unknown[]> }

async function fixture(
  context: TestContext,
  cleanup?: () => void | Promise<void>
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'phi-inbox-writer-'))
  context.after(async () => {
    try {
      await cleanup?.()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  return directory
}

async function launchWriter(
  children: WriterChild[],
  directory: string
): Promise<WriterChild & { result: unknown }> {
  const fixture = `
    import { tryAcquireAssistantInboxWriter } from ${JSON.stringify(source.href)}
    const owner = tryAcquireAssistantInboxWriter(process.argv[1])
    process.send(owner ? 'acquired' : 'busy', () => {
      if (!owner) process.disconnect()
    })
    if (owner) process.on('disconnect', () => owner.release())
  `
  const child = spawn(
    process.execPath,
    ['--import', loader, '--input-type=module', '--eval', fixture, directory],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  )
  const exit = once(child, 'exit')
  children.push({ child, exit })
  let diagnostic = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-2000)
  })
  const result = await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(6000) }).then(([message]) => message),
    exit.then(([code, signal]) => {
      throw new Error(`Writer exited before replying (${code ?? signal}): ${diagnostic}`)
    })
  ])
  return { child, result, exit }
}

test(
  'writer ownership stays exclusive across processes and can be reacquired after a crash',
  {
    timeout: 15_000
  },
  async (context) => {
    const children: WriterChild[] = []
    const directory = await fixture(context, async () => {
      await Promise.all(
        children.map(async ({ child, exit }) => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          await exit.catch(() => undefined)
        })
      )
    })
    const peerDirectory = join(directory, 'another-inbox')
    await mkdir(peerDirectory, { mode: 0o700 })

    const first = await launchWriter(children, directory)
    assert.equal(first.result, 'acquired')
    const before = await stat(join(directory, lockFile))
    const contender = await launchWriter(children, directory)
    assert.equal(contender.result, 'busy')
    const peer = await launchWriter(children, peerDirectory)
    assert.equal(peer.result, 'acquired')

    assert.equal(first.child.kill('SIGKILL'), true)
    await first.exit
    const successor = await launchWriter(children, directory)
    assert.equal(successor.result, 'acquired')
    const after = await stat(join(directory, lockFile))
    assert.equal(after.ino, before.ino)
    assert.equal(peer.child.exitCode, null)
  }
)

test('release is idempotent and does not release a successor on the same directory', async (context) => {
  const owners: { release(): void }[] = []
  const directory = await fixture(context, () => {
    for (const owner of owners) owner.release()
  })
  const first = tryAcquireAssistantInboxWriter(directory)
  assert.ok(first)
  owners.push(first)
  assert.equal(tryAcquireAssistantInboxWriter(directory), null)
  first.release()
  const second = tryAcquireAssistantInboxWriter(directory)
  assert.ok(second)
  owners.push(second)
  first.release()
  assert.equal(tryAcquireAssistantInboxWriter(directory), null)
})

test('an invalid lock fails closed instead of becoming a new owner', async (context) => {
  const directory = await fixture(context)
  const directoryOccupyingFile = join(directory, lockFile)
  await mkdir(directoryOccupyingFile)
  assert.throws(() => tryAcquireAssistantInboxWriter(directory))
  await rm(directoryOccupyingFile, { recursive: true })
  await writeFile(directoryOccupyingFile, 'invalid database', { mode: 0o600 })
  assert.throws(() => tryAcquireAssistantInboxWriter(directory))
  assert.equal(await readFile(directoryOccupyingFile, 'utf8'), 'invalid database')
  const missing = join(directory, 'missing-directory')
  assert.throws(() => tryAcquireAssistantInboxWriter(missing))
})

test(
  'a linked database is rejected before SQLite opens it',
  { skip: process.platform === 'win32' },
  async (context) => {
    const directory = await fixture(context)
    const original = join(directory, 'different-file')
    await writeFile(original, 'unchanged', { mode: 0o600 })
    await symlink(original, join(directory, lockFile))
    assert.throws(() => tryAcquireAssistantInboxWriter(directory))
    assert.equal(await readFile(original, 'utf8'), 'unchanged')
  }
)
