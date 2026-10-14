import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

interface Snapshot {
  produced: number
  canceled: number
  aborted: number
  finished: number
}
async function fixture(
  t: test.TestContext
): Promise<{ port: number; snapshot(): Promise<Snapshot> }> {
  const root = await mkdtemp(join(tmpdir(), 'phi-gateway-http-'))
  const child = spawn(
    resolveBunExecutable(),
    [fileURLToPath(new URL('./helpers/model-gateway-http-child.ts', import.meta.url))],
    {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', HOME: root },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  let stderr = ''
  child.stderr.on('data', (bytes: Buffer) => {
    stderr += bytes.toString()
  })
  const pending = new Map<
    number,
    { resolve(value: Snapshot): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >()
  let sequence = 0
  const lines = createInterface({ input: child.stdout })
  const ready = new Promise<number>((resolve) => {
    lines.on('line', (line) => {
      const value = JSON.parse(line) as Snapshot & { id?: number; ready?: boolean; port: number }
      if (value.ready) resolve(value.port)
      else if (value.id !== undefined) {
        const item = pending.get(value.id)
        clearTimeout(item?.timer)
        item?.resolve(value)
        pending.delete(value.id)
      }
    })
  })
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
  child.once('close', () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('HTTP fixture stopped before responding'))
    }
    pending.clear()
  })
  const command = (stop = false): Promise<Snapshot> =>
    new Promise((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(new Error('HTTP fixture is closed'))
        return
      }
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('HTTP fixture command timed out'))
      }, 5000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id, stop }) + '\n', (error) => {
        if (!error) return
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      })
    })
  t.after(async () => {
    try {
      await command(true)
      child.stdin.end()
      assert.equal(await exited, 0)
      assert.equal(stderr, '')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
      lines.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  const port = await Promise.race([
    ready,
    exited.then(() => {
      throw new Error('HTTP fixture startup failed')
    })
  ])
  return { port, snapshot: () => command() }
}

for (const action of ['resume', 'disconnect'] as const) {
  test(
    `pinned Bun production HTTP adapter bounds a paused complete POST and handles ${action}`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t)
      const socket = createConnection(f.port, '127.0.0.1')
      t.after(() => socket.destroy())
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      socket.pause()
      socket.write(
        'POST /stream HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}'
      )
      await delay(200)
      const first = await f.snapshot()
      await delay(200)
      const second = await f.snapshot()
      assert.ok(first.produced > 0 && first.produced < 8 * 1024 * 1024)
      assert.equal(
        second.produced,
        first.produced,
        'The network layer must stop consuming the source'
      )
      assert.equal(second.aborted, 0)
      if (action === 'resume') {
        let headers = Buffer.alloc(0)
        let bodyBytes = 0
        let inBody = false
        const ended = new Promise<void>((resolve, reject) => {
          socket.on('data', (bytes: Buffer) => {
            if (!inBody) {
              headers = Buffer.concat([headers, bytes])
              const end = headers.indexOf('\r\n\r\n')
              if (end < 0) return
              assert.match(headers.subarray(0, end).toString(), /HTTP\/1.1 200/)
              bytes = headers.subarray(end + 4)
              inBody = true
            }
            assert.ok(bytes.every((byte) => byte === 120))
            bodyBytes += bytes.byteLength
          })
          socket.once('end', resolve)
          socket.once('error', reject)
        })
        socket.resume()
        await ended
        assert.equal(bodyBytes, 64 * 1024 * 1024)
        const final = await f.snapshot()
        assert.equal(final.finished, 1)
        assert.equal(final.aborted, 0, 'Normal completion must not be treated as cancellation')
      } else {
        socket.destroy()
        const deadline = Date.now() + 500
        let final = await f.snapshot()
        while (!final.aborted && Date.now() < deadline) {
          await delay(10)
          final = await f.snapshot()
        }
        assert.equal(final.aborted, 1)
        assert.equal(final.canceled, 1)
        assert.equal(final.finished, 0)
      }
    }
  )
}
