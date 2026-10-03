import { Process, ProcessStatus, PtySession, type PtyRunResult } from '@oh-my-pi/pi-natives'

export const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
export const NORMAL_TIMEOUT_MS = 5_000

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out after ${timeoutMs}ms`)
    await delay(20)
  }
}

export function cleanEvidence(value: unknown): string {
  return String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 800)
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function uniqueSentinel(id: string): string {
  return `__PHI_${id}_${crypto.randomUUID().replaceAll('-', '')}__`
}

export function emitSentinel(value: string): string {
  const encoded = Buffer.from(value).toString('base64')
  return `printf %s ${shellQuote(encoded)} | /usr/bin/base64 -D`
}

export function normalizeTerminalText(value: string): string {
  return value.replaceAll('\r', '').replace(/^\n/, '').replace(/\n$/, '')
}

export class TextCollector {
  text = ''
  chunks = 0
  splitCodePoint = false
  errors: string[] = []
  private waiters = new Set<() => void>()
  private previousEndedHighSurrogate = false

  append(error: Error | null, chunk: string): void {
    if (error) this.errors.push(error.message)
    if (!chunk) return
    const beginsLowSurrogate = /[\uDC00-\uDFFF]/.test(chunk[0] ?? '')
    const endsHighSurrogate = /[\uD800-\uDBFF]/.test(chunk.at(-1) ?? '')
    if (this.previousEndedHighSurrogate || beginsLowSurrogate || endsHighSurrogate) {
      this.splitCodePoint = true
    }
    this.previousEndedHighSurrogate = endsHighSurrogate
    this.text += chunk
    this.chunks += 1
    for (const notify of [...this.waiters]) notify()
  }

  async waitFor(needle: string, timeoutMs = NORMAL_TIMEOUT_MS, from = 0): Promise<number> {
    const existing = this.text.indexOf(needle, from)
    if (existing >= 0) return existing
    return await withTimeout(
      new Promise<number>((resolveWait) => {
        const check = (): void => {
          const index = this.text.indexOf(needle, from)
          if (index < 0) return
          this.waiters.delete(check)
          resolveWait(index)
        }
        this.waiters.add(check)
      }),
      timeoutMs,
      `sentinel ${needle}`
    )
  }
}

export class FloodCollector {
  readonly capBytes = 2 * 1024 * 1024
  chunks = 0
  totalBytes = 0
  droppedBytes = 0
  retainedBytes = 0
  lastChunkAt = 0
  private buffers: Buffer[] = []
  private head = 0
  private quietWaiters = new Set<() => void>()

  append(_error: Error | null, chunk: string): void {
    if (!chunk) return
    this.chunks += 1
    this.lastChunkAt = performance.now()
    let bytes = Buffer.from(chunk)
    this.totalBytes += bytes.byteLength
    if (bytes.byteLength >= this.capBytes) {
      this.droppedBytes += this.retainedBytes + bytes.byteLength - this.capBytes
      bytes = bytes.subarray(bytes.byteLength - this.capBytes)
      this.buffers = [bytes]
      this.head = 0
      this.retainedBytes = bytes.byteLength
    } else {
      this.buffers.push(bytes)
      this.retainedBytes += bytes.byteLength
      while (this.retainedBytes > this.capBytes && this.head < this.buffers.length) {
        const first = this.buffers[this.head]
        const excess = this.retainedBytes - this.capBytes
        if (first.byteLength <= excess) {
          this.head += 1
          this.retainedBytes -= first.byteLength
          this.droppedBytes += first.byteLength
        } else {
          this.buffers[this.head] = first.subarray(excess)
          this.retainedBytes -= excess
          this.droppedBytes += excess
        }
      }
      if (this.head > 512) {
        this.buffers = this.buffers.slice(this.head)
        this.head = 0
      }
    }
    for (const reset of [...this.quietWaiters]) reset()
  }

  async waitForQuiet(quietMs: number, timeoutMs: number): Promise<number> {
    const interruptedAt = performance.now()
    let timer: NodeJS.Timeout | undefined
    let timeout: NodeJS.Timeout | undefined
    return await new Promise<number>((resolveQuiet, reject) => {
      const done = (): void => {
        if (timer) clearTimeout(timer)
        if (timeout) clearTimeout(timeout)
        this.quietWaiters.delete(reset)
        resolveQuiet(Math.max(0, this.lastChunkAt - interruptedAt))
      }
      const reset = (): void => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(done, quietMs)
      }
      this.quietWaiters.add(reset)
      timeout = setTimeout(() => {
        if (timer) clearTimeout(timer)
        this.quietWaiters.delete(reset)
        reject(new Error(`output did not become quiet within ${timeoutMs}ms`))
      }, timeoutMs)
      reset()
    })
  }
}

export type ShellHandle = {
  pty: PtySession
  pid: number
  processRef: Process
  exitPromise: Promise<PtyRunResult>
  collector: TextCollector | FloodCollector
  closed: boolean
}

export function allowlistEnvironment(): Record<string, string> {
  const allowed = new Set([
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSH_AUTH_SOCK'
  ])
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (allowed.has(key) || key.startsWith('LC_'))) env[key] = value
  }
  env.LANG ||= 'en_US.UTF-8'
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Phi'
  env.PATH = MINIMAL_PATH
  return env
}

export async function startShell(
  cwd: string,
  env: Record<string, string>,
  collector: TextCollector | FloodCollector = new TextCollector(),
  launch?: { application: string; args: string[] }
): Promise<ShellHandle> {
  const shell = process.env.SHELL || '/bin/zsh'
  const target = launch ?? { application: shell, args: ['-il'] }
  const pty = new PtySession()
  let resolveStarted: (pid: number) => void
  let rejectStarted: (error: Error) => void
  const started = new Promise<number>((resolveStart, rejectStart) => {
    resolveStarted = resolveStart
    rejectStarted = rejectStart
  })
  const exitPromise = pty.startArgv(
    { ...target, cwd, env, cols: 100, rows: 30 },
    (error, chunk) => collector.append(error, chunk),
    (error, pid) => {
      if (error) rejectStarted(error)
      else resolveStarted(pid)
    }
  )
  void exitPromise.catch((error) =>
    rejectStarted(error instanceof Error ? error : new Error(String(error)))
  )
  const pid = await withTimeout(started, NORMAL_TIMEOUT_MS, 'PTY onStart')
  const processRef = Process.fromPid(pid)
  if (!processRef)
    throw new Error(`Process.fromPid(${pid}) returned null immediately after onStart`)
  return { pty, pid, processRef, exitPromise, collector, closed: false }
}

export async function frame(
  handle: ShellHandle,
  body: string,
  timeoutMs = NORMAL_TIMEOUT_MS
): Promise<string> {
  if (!(handle.collector instanceof TextCollector)) throw new Error('frame requires TextCollector')
  const start = uniqueSentinel('FRAME_START')
  const end = uniqueSentinel('FRAME_END')
  const offset = handle.collector.text.length
  handle.pty.write(
    `stty -echo; ${emitSentinel(start)}; printf '\\n'; ${body}; printf '\\n'; ${emitSentinel(end)}; printf '\\n'; stty echo\n`
  )
  const startAt = await handle.collector.waitFor(start, timeoutMs, offset)
  const endAt = await handle.collector.waitFor(end, timeoutMs, startAt + start.length)
  return normalizeTerminalText(handle.collector.text.slice(startAt + start.length, endAt))
}

export function descendants(root: Process): Process[] {
  const found: Process[] = []
  const visit = (parent: Process): void => {
    for (const child of parent.children()) {
      found.push(child)
      visit(child)
    }
  }
  visit(root)
  return found
}

export function allExited(refs: Process[]): boolean {
  return refs.every((ref) => ref.status() === ProcessStatus.Exited)
}

export async function closeHandle(handle: ShellHandle): Promise<void> {
  if (handle.closed) return
  handle.closed = true
  if (handle.processRef.status() === ProcessStatus.Running) {
    await handle.processRef
      .terminate({ group: true, gracefulMs: -1, timeoutMs: 1_000 })
      .catch(() => false)
  }
  await withTimeout(
    handle.exitPromise.catch(() => ({ cancelled: true, timedOut: false })),
    1_500,
    'PTY exit'
  ).catch(() => undefined)
}

export async function prepareLongRunningChildren(
  handle: ShellHandle,
  options: { background: boolean; jobControl?: boolean }
): Promise<Process[]> {
  if (!(handle.collector instanceof TextCollector))
    throw new Error('child setup requires TextCollector')
  const ready = uniqueSentinel('CHILD_READY')
  const offset = handle.collector.text.length
  const background = options.background ? '/bin/sleep 300 & ' : ''
  const jobControl = options.jobControl ? 'set -m; ' : ''
  const inner = `trap "" HUP; ${emitSentinel(ready)}; printf '\\n'; exec /bin/sleep 300`
  handle.pty.write(`${jobControl}${background}/bin/sh -c ${shellQuote(inner)}\n`)
  await handle.collector.waitFor(ready, NORMAL_TIMEOUT_MS, offset)
  const expectedDirectChildren = options.background ? 2 : 1
  await waitUntil(
    () => handle.processRef.children().length >= expectedDirectChildren,
    1_000,
    'long-running child discovery'
  )
  return descendants(handle.processRef)
}
