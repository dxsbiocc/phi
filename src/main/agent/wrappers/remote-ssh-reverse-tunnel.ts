import type { RemoteExecResult } from './remote-ssh-session'

export interface RemoteReverseTunnel {
  readonly remotePort: number
  readonly closed: Promise<void>
  close(): Promise<void>
}

export interface ReverseTunnelOptions {
  readonly localPort: number
  readonly signal?: AbortSignal
  /** Revoke upper gateway access immediately, including before acquisition returns. */
  readonly onInvalidated?: () => void
}

export function assertTunnelPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid reverse tunnel port')
}

export function reverseTunnelSpecification(localPort: number): string {
  assertTunnelPort(localPort)
  return `127.0.0.1:0:127.0.0.1:${localPort}`
}

export function parseAllocatedTunnelPort(stdout: string): number {
  if (!/^[1-9][0-9]{0,4}\r?\n?$/.test(stdout))
    throw new Error('SSH did not return one allocated reverse tunnel port')
  const port = Number(stdout.trim())
  assertTunnelPort(port)
  return port
}

export const INSPECT_REVERSE_TUNNEL_COMMAND = `set -eu
printf 'PHI_TCP4\\n'
cat /proc/net/tcp
printf 'PHI_TCP6\\n'
cat /proc/net/tcp6`

/** Linux exposes words in host byte order; supported release architectures are little endian. */
export function assertLoopbackTunnelBinding(output: string, port: number): void {
  assertTunnelPort(port)
  const sections = output.split(/^PHI_TCP[46]\r?$/m)
  if (
    sections.length !== 3 ||
    sections[0] !== '' ||
    !output.startsWith('PHI_TCP4\n') ||
    !output.includes('\nPHI_TCP6\n')
  )
    throw new Error('Cannot prove reverse tunnel loopback binding')
  let matched = 0
  for (const [index, section] of sections.slice(1).entries()) {
    const lines = section.trim().split(/\r?\n/)
    if (!/^\s*sl\s+local_address\s+rem(?:ote)?_address\s+st\b/.test(lines.shift() ?? ''))
      throw new Error('Invalid Linux socket inspection header')
    for (const line of lines) {
      const fields = line.trim().split(/\s+/)
      const local = /^([0-9A-F]+):([0-9A-F]{4})$/i.exec(fields[1] ?? '')
      if (
        !/^\d+:$/.test(fields[0] ?? '') ||
        !local ||
        local[1].length !== (index ? 32 : 8) ||
        !/^[0-9A-F]{2}$/i.test(fields[3] ?? '')
      )
        throw new Error('Invalid Linux socket inspection row')
      if (Number.parseInt(local[2], 16) !== port || fields[3].toUpperCase() !== '0A') continue
      const address = local[1].toUpperCase()
      const loopback = index
        ? address === '00000000000000000000000001000000' ||
          /^0000000000000000FFFF0000[0-9A-F]{6}7F$/.test(address)
        : /^[0-9A-F]{6}7F$/.test(address)
      if (!loopback) throw new Error('SSH reverse tunnel is not bound exclusively to loopback')
      matched++
    }
  }
  if (!matched) throw new Error('No listening reverse tunnel socket was confirmed')
}

export async function openReverseTunnelLease(
  options: ReverseTunnelOptions & {
    readonly connectionSignal: AbortSignal
    forward(signal: AbortSignal): Promise<RemoteExecResult>
    cancel(): Promise<RemoteExecResult>
    inspect(signal: AbortSignal): Promise<RemoteExecResult>
    onCleanupComplete?(): void
  }
): Promise<RemoteReverseTunnel> {
  assertTunnelPort(options.localPort)
  const controller = new AbortController()
  const signal = controller.signal
  let invalidated = false
  let started = false
  let forwardSettled = false
  let pendingForward: Promise<RemoteExecResult> | undefined
  let closing: Promise<void> | undefined
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const invalidate = (): void => {
    if (invalidated) return
    invalidated = true
    controller.abort(new Error('SSH reverse tunnel was invalidated'))
    resolveClosed()
    try {
      void Promise.resolve(options.onInvalidated?.()).catch(() => undefined)
    } catch {
      /* Observers cannot skip tunnel cancellation. */
    }
  }
  const close = (): Promise<void> => {
    invalidate()
    closing ??= (async () => {
      options.signal?.removeEventListener('abort', onAbort)
      options.connectionSignal.removeEventListener('abort', onAbort)
      await pendingForward?.catch(() => undefined)
      if (!started || options.connectionSignal.aborted) {
        options.onCleanupComplete?.()
        return
      }
      const result = await options.cancel()
      if (result.code !== 0 || result.signal)
        throw new Error('SSH reverse tunnel cancellation could not be confirmed')
      options.onCleanupComplete?.()
    })()
    return closing
  }
  const onAbort = (): void => {
    void close().catch(() => undefined)
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  options.connectionSignal.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted || options.connectionSignal.aborted) onAbort()
  try {
    signal.throwIfAborted()
    started = true
    pendingForward = Promise.resolve().then(() => options.forward(signal))
    void pendingForward.then(
      () => {
        forwardSettled = true
      },
      () => {
        forwardSettled = true
      }
    )
    const result = await untilCancelled(pendingForward, signal)
    signal.throwIfAborted()
    if (result.code !== 0 || result.signal) throw new Error('SSH reverse tunnel allocation failed')
    const remotePort = parseAllocatedTunnelPort(result.stdout)
    const inspected = await untilCancelled(options.inspect(signal), signal)
    signal.throwIfAborted()
    if (inspected.code !== 0 || inspected.signal)
      throw new Error('Cannot inspect SSH reverse tunnel loopback binding')
    assertLoopbackTunnelBinding(inspected.stdout, remotePort)
    return { remotePort, closed, close }
  } catch (error) {
    invalidate()
    const cleanup = close()
    void cleanup.catch(() => undefined)
    if (forwardSettled) await cleanup.catch(() => undefined)
    if (options.signal?.aborted) throw options.signal.reason
    throw error
  }
}

async function untilCancelled<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason)
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
      })
    ])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
