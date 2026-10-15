import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import { childHook } from './helpers/rpcCursorChildHook'

test('Cursor parallel provider setup preserves its original error and attempts every owned cleanup', async () => {
  const source = ts.transpileModule(
    await readFile(new URL('./helpers/rpcCursorChildProvider.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    }
  ).outputText
  const require = createRequire(import.meta.url)
  for (const cleanupThrows of [false, true]) {
    const calls = { provider: 0, upstream: 0, server: 0 }
    const failure = new Error('synthetic Cursor barrier listen failed')
    const upstream = Object.assign(new EventEmitter(), {
      destroy: (): void => {
        calls.upstream++
        if (cleanupThrows) throw new Error('secondary upstream cleanup failure')
      }
    })
    const server = Object.assign(new EventEmitter(), {
      listen: (): void => queueMicrotask(() => server.emit('error', failure)),
      close: (done: () => void): void => {
        calls.server++
        done()
      }
    })
    const module = {
      exports: {} as { startCursorChildProvider(parallel: boolean): Promise<unknown> }
    }
    runInNewContext(source, {
      module,
      exports: module.exports,
      require: (name: string): unknown =>
        name === 'node:http2'
          ? { connect: () => upstream, createServer: () => server }
          : name === './loopbackCursor'
            ? {
                startLoopbackCursor: async () => ({
                  url: 'http://127.0.0.1:1',
                  close: async (): Promise<void> => {
                    calls.provider++
                  }
                })
              }
            : require(name),
      queueMicrotask
    })
    await assert.rejects(
      module.exports.startCursorChildProvider(true),
      (error) => error === failure
    )
    assert.deepEqual(calls, { provider: 1, upstream: 1, server: 1 })
  }
})

test('Cursor child hook queues one hidden SDK continuation without changing the retained error or content', async () => {
  const f = childHook()
  const message = await f.message()
  assert.equal(message.errorMessage, 'Cursor stream ended before turnEnded')
  assert.equal(message.errorId, 0)
  assert.deepEqual(message.content, [{ type: 'text', text: 'retained partial' }])
  await f.message()
  assert.equal(f.queued.length, 1)
  assert.match(String(f.queued[0].content), /retained conversation and completed tool results/)
  f.start()
  await f.message()
  assert.equal(f.queued.length, 2, 'a new explicit submission owns its own bounded allowance')
})

for (const all of [false, true])
  test(`Cursor child hook stop preserves undelivered users and removes only its restored continuation: ${all}`, async () => {
    const f = childHook()
    const user = f.queueUser()
    await f.message()
    f.claim(!all)
    f.abort()
    f.restore()
    assert.deepEqual(f.pending(), [user])
    assert.equal(f.pending()[0], user)
    f.shutdown()
    assert.equal(f.listeners(), 0)
  })

test('Cursor child hook observes the later native continuation abort with its original signal still live', async () => {
  const f = childHook()
  const user = f.queueUser()
  await f.message()
  f.claim()
  f.abortContinuation()
  f.restore()
  assert.deepEqual(f.pending(), [user])
  f.shutdown()
  assert.equal(f.listeners(), 0)
})

test('Cursor child hook shutdown never erases an undelivered user record', async () => {
  const f = childHook()
  const user = f.queueUser()
  await f.message()
  f.claim(true)
  f.shutdown()
  assert.equal(f.listeners(), 0)
  f.restore()
  assert.equal(f.pending()[0], user)
})

test('Cursor child hook retires its queue watchers only after actual message delivery', async () => {
  const f = childHook()
  await f.message()
  assert.equal(f.listeners(), 2)
  f.consume()
  assert.equal(f.listeners(), 0)
  assert.equal(f.pending().length, 0)
})

test('Cursor child hook never queues after cancellation, for Main, or for completed tool recovery', async () => {
  const child = childHook()
  await child.message(AbortSignal.abort())
  assert.equal(child.queued.length, 0)
  const main = childHook('main')
  await main.message()
  assert.equal(main.queued.length, 0)
  const tool = await child.message(undefined, true)
  assert.equal(child.queued.length, 0)
  assert.match(String(tool.errorMessage), /^stream closed before a terminal response event:/)
})

test('Cursor child hook proves only its exact live queued message and retires that proof', async () => {
  const f = childHook()
  assert.equal(f.ownsContinuation(), false)
  f.queueUser()
  assert.equal(f.ownsContinuation(), false)
  await f.message()
  assert.equal(f.ownsContinuation(), true)
  f.claim(true)
  assert.equal(f.ownsContinuation(), false, 'undelivered messages cannot grant queued cancellation')
  f.restore()
  assert.equal(f.ownsContinuation(), true)
  f.consume()
  assert.equal(f.ownsContinuation(), false)
  f.shutdown()
  assert.equal(f.listeners(), 0)
})

test('Cursor child hook rejects a copied nonce message and an aborted generation', async () => {
  const copy = childHook()
  await copy.message()
  copy.cloneQueuedContinuation()
  assert.equal(
    copy.ownsContinuation(),
    false,
    'matching custom type and nonce cannot replace ownership'
  )
  copy.shutdown()
  const cancelled = childHook()
  await cancelled.message()
  assert.equal(cancelled.ownsContinuation(), true)
  cancelled.abort()
  assert.equal(cancelled.ownsContinuation(), false)
  cancelled.shutdown()
  assert.equal(cancelled.listeners(), 0)
})

for (const mode of ['text', 'repeat', 'tool', 'stop', 'parallel', 'queued-stop'])
  test(`actual composed Cursor child recovery: ${mode}`, { timeout: 120000 }, async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'phi-facade-regression-cursor-child-'))
    )
    let output = ''
    let child: ReturnType<typeof spawn> | undefined
    let closed: Promise<number | null> | undefined
    const abort = (): void => {
      t.diagnostic(output)
      child?.kill()
    }
    try {
      for (const name of ['home', 'agent', 'tmp']) await mkdir(join(root, name), { mode: 0o700 })
      child = spawn(
        process.execPath,
        ['--import', './scripts/test-loader.mjs', './tests/helpers/rpcCursorChildOracle.ts'],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: join(root, 'home'),
            PI_CODING_AGENT_DIR: join(root, 'agent'),
            TMPDIR: join(root, 'tmp'),
            XDG_DATA_HOME: join(root, 'home/.local/share'),
            XDG_CACHE_HOME: join(root, 'home/.cache'),
            PHI_TEST_REAL_BUN: resolveBunExecutable(),
            PHI_CURSOR_CHILD_MODE: mode,
            PHI_OMP_WORKER_PATH: join(process.cwd(), 'src/main/agent/engine/in-process/main.ts')
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      closed = new Promise((resolve, reject) => {
        child!.once('error', reject)
        child!.once('close', resolve)
      })
      for (const stream of [child.stdout, child.stderr])
        stream?.on('data', (chunk) => {
          output = (output + chunk.toString()).slice(-32768)
        })
      t.signal.addEventListener('abort', abort, { once: true })
      assert.equal(await closed, 0, output)
      t.diagnostic(output.trim())
    } finally {
      t.signal.removeEventListener('abort', abort)
      if (child?.exitCode === null && child.signalCode === null) child.kill()
      await closed?.catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })
