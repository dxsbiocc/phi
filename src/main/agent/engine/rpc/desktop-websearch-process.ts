import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveBunExecutable, workerPathWithBun } from '../bun-executable'
import { RpcFrameCodec, encodeRpcCommand } from './frame-codec'

/** One bounded, owned SDK process. A failed query is never replayed automatically. */
export class DesktopWebSearchProcess {
  private pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >()
  private outputFailure?: Error
  private exitCode?: number | null
  private failure?: Error
  private closing?: Promise<void>
  private readonly closed: Promise<void>
  private readonly codec = new RpcFrameCodec()
  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly cwd: string
  ) {
    this.codec.enableProtocolV2()
    this.closed = new Promise((resolve) => {
      child.once('close', (code) => {
        this.exitCode = code
        try {
          this.codec.finish()
        } catch {
          this.outputFailure = new Error('Desktop search output was incomplete')
          this.fail(this.outputFailure)
        }
        this.fail(new Error('Desktop search worker exited'))
        resolve()
      })
    })
    child.on('error', () => this.fail(new Error('Desktop search worker could not start')))
    child.stdin.on('error', () => this.fail(new Error('Desktop search input failed')))
    // SDK/provider stderr may contain credentials. Never retain or forward it.
    child.stderr.resume()
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const frame of this.codec.push(chunk)) {
          if (
            frame.type !== 'reply' ||
            typeof frame.id !== 'string' ||
            (frame.error !== undefined && typeof frame.error !== 'string')
          )
            throw new Error('Invalid desktop search reply')
          const pending = this.pending.get(frame.id)
          if (!pending) continue // Cancelled/retired replies cannot satisfy another invocation.
          this.pending.delete(frame.id)
          if (typeof frame.error === 'string') pending.reject(new Error(frame.error))
          else pending.resolve(frame.value)
        }
      } catch {
        this.outputFailure = new Error('Desktop search output failed validation')
        this.fail(this.outputFailure)
        void this.close().catch(() => {})
      }
    })
  }
  static async start(workerPath: string, env: NodeJS.ProcessEnv): Promise<DesktopWebSearchProcess> {
    const cwd = await mkdtemp(join(tmpdir(), 'phi-desktop-search-'))
    try {
      const bun = resolveBunExecutable({ env, resourcesPath: process.resourcesPath })
      return new DesktopWebSearchProcess(
        spawn(bun, ['--no-env-file', workerPath], {
          cwd,
          env: { ...env, PATH: workerPathWithBun(bun, env.PATH) },
          stdio: 'pipe',
          windowsHide: true,
          detached: process.platform !== 'win32'
        }),
        cwd
      )
    } catch (error) {
      await rm(cwd, { recursive: true, force: true })
      throw error
    }
  }
  request(command: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    if (this.failure || this.closing)
      return Promise.reject(this.failure ?? new Error('Desktop search worker closing'))
    if (this.pending.size >= 64)
      return Promise.reject(new Error('Too many desktop search requests'))
    const id = randomUUID()
    let bytes: Buffer
    try {
      bytes = encodeRpcCommand({ ...command, id })
    } catch (error) {
      return Promise.reject(error)
    }
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', abort)
        reject(signal?.reason ?? new Error('Desktop search cancelled'))
        this.write({ type: 'cancel', id })
      }
      this.pending.set(id, {
        resolve(value) {
          signal?.removeEventListener('abort', abort)
          resolve(value)
        },
        reject(error) {
          signal?.removeEventListener('abort', abort)
          reject(error)
        }
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }
      this.child.stdin.write(bytes, (error) => {
        if (error) this.fail(new Error('Desktop search input failed'))
      })
    })
  }
  private write(frame: Record<string, unknown>): void {
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded)
      this.child.stdin.write(encodeRpcCommand(frame), () => {})
  }
  private fail(error: Error): void {
    this.failure ??= error
    for (const pending of this.pending.values()) pending.reject(this.failure)
    this.pending.clear()
  }
  private terminate(signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal)
      else this.child.kill(signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.child.kill(signal)
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.fail(new Error('Desktop search worker closed'))
      this.write({ type: 'close', id: randomUUID() })
      this.child.stdin.end()
      // Native SDK !command resolution owns a detached child with a 10s timeout.
      // Let that owner reap its helper before terminating the query process.
      const terminate = setTimeout(() => this.terminate('SIGTERM'), 12_000)
      const kill = setTimeout(() => this.terminate('SIGKILL'), 15_000)
      try {
        await this.closed
        if (this.outputFailure) throw this.outputFailure
        if (this.exitCode !== 0) throw new Error('Desktop search worker did not close cleanly')
      } finally {
        clearTimeout(terminate)
        clearTimeout(kill)
        await rm(this.cwd, { recursive: true, force: true })
      }
    })())
  }
}
