import { posix } from 'node:path'
import type { RemoteStdioProcess } from '../../../wrappers/remote-ssh-session'
import { shellQuote as q } from '../../../wrappers/remote-ssh-session'
import { assertRemoteRoot, privateRemotePrefix } from './remote-commands'

export interface ExtensionLock {
  readonly lost: Promise<never>
  release(): Promise<void>
}

export class RemoteLockBusyError extends Error {
  constructor() {
    super('Another active writer holds the server lock')
    this.name = 'RemoteLockBusyError'
  }
}

export interface OwnedRemoteLockOptions {
  root: string
  directory: string
  basename: string
  openStdio: (command: string) => Promise<RemoteStdioProcess>
  signal: AbortSignal
  waitMs?: number
}

/** Preserve extension deployment's accepted location and acquisition defaults. */
export function acquireExtensionLock(options: {
  root: string
  contentHash: string
  openStdio: (command: string) => Promise<RemoteStdioProcess>
  signal: AbortSignal
}): Promise<ExtensionLock> {
  return acquireOwnedRemoteLock({
    ...options,
    directory: posix.join(options.root, 'extension-locks'),
    basename: options.contentHash
  })
}

/** A server kernel lock lives exactly as long as this owned stdio process's fd. */
export async function acquireOwnedRemoteLock(
  options: OwnedRemoteLockOptions
): Promise<ExtensionLock> {
  const { signal, directory, basename } = options
  const waitMs = options.waitMs ?? 30_000
  assertRemoteRoot(options.root)
  const relative = posix.relative(options.root, directory)
  if (
    !posix.isAbsolute(directory) ||
    posix.normalize(directory) !== directory ||
    directory.endsWith('/') ||
    options.root.endsWith('/') ||
    !relative ||
    relative === '..' ||
    relative.startsWith('../') ||
    /[\0\r\n]/.test(directory) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(basename) ||
    basename.includes('..') ||
    !Number.isSafeInteger(waitMs) ||
    waitMs < 0 ||
    waitMs > 30_000
  )
    throw new Error('Invalid owned remote lock location or wait budget')
  signal.throwIfAborted()
  const directories = relative
    .split('/')
    .map((_, index, segments) => posix.join(options.root, ...segments.slice(0, index + 1)))
  const path = posix.join(directory, basename)
  const command = `cd -- ${q(options.root)} || exit 1\n${privateRemotePrefix(options.root)}
${directories.map((managed) => `private_dir ${q(managed)}`).join('\n')}
command -v flock >/dev/null 2>&1 || fail 'Server requires the flock utility for connection-owned extension deployment locks'
if [ ! -e ${q(path)} ] && [ ! -L ${q(path)} ]; then (set -C; : > ${q(path)}) 2>/dev/null || true; fi
private_file ${q(path)}
exec 9<>${q(path)}
deadline=$(($(date +%s) + ${Math.ceil(waitMs / 1000)}))
while ! flock -x -n 9; do
  [ "$(date +%s)" -lt "$deadline" ] || fail 'Another active extension deployment holds the server lock'
  sleep 0.05
done
printf 'PHI_EXTENSION_LOCKED\\n'
# EOF on the existing SSH channel releases fd 9 even when an exec cleanup cannot connect.
while IFS= read -r _line; do :; done`
  let abort!: () => void
  const opening = options.openStdio(command)
  void opening.then(
    (late) => {
      if (signal.aborted) void late.close().catch(() => undefined)
    },
    () => undefined
  )
  const channel = await Promise.race([
    opening,
    new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  ]).finally(() => signal.removeEventListener('abort', abort))
  let released = false
  let closePromise: Promise<void> | undefined
  let rejectLost!: (cause: Error) => void
  const eof = (): void => {
    if (!released) rejectLost(new Error('Server extension deployment lock output ended'))
  }
  const streamError = (cause: Error): void => {
    if (!released) rejectLost(cause)
  }
  const detach = (): void => {
    channel.stdout.off('end', eof)
    channel.stdout.off('close', eof)
    channel.stdout.off('error', streamError)
    channel.stderr.off('error', streamError)
    channel.stdin.off('error', streamError)
  }
  const release = (): Promise<void> => {
    released = true
    closePromise ??= channel.close().finally(detach)
    return closePromise
  }
  const lost = new Promise<never>((_, reject) => {
    rejectLost = reject
    void channel.closed.then(
      () => {
        if (!released) reject(new Error('Server extension deployment lock channel disconnected'))
      },
      (error: Error) => {
        if (!released) reject(error)
      }
    )
  })
  void lost.catch(() => undefined)
  channel.stdout.on('end', eof).on('close', eof).on('error', streamError)
  channel.stderr.on('error', streamError)
  channel.stdin.on('error', streamError)
  if (channel.stdout.readableEnded || channel.stdout.destroyed) eof()
  let output = ''
  let stderr = ''
  const errorData = (bytes: Buffer): void => {
    stderr = (stderr + bytes.toString('utf8')).slice(-4096)
  }
  channel.stderr.on('data', errorData)
  let readyData!: (bytes: Buffer) => void
  let cancelled!: () => void
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      lost,
      new Promise<void>((resolve, reject) => {
        readyData = (bytes) => {
          output += bytes.toString('utf8')
          if (output === 'PHI_EXTENSION_LOCKED\n') resolve()
          else if (output.length > 1024 || output.includes('\n'))
            reject(new Error('Invalid extension deployment lock handshake'))
        }
        channel.stdout.on('data', readyData)
        cancelled = () => reject(signal.reason)
        signal.addEventListener('abort', cancelled, { once: true })
        if (signal.aborted) cancelled()
        timer = setTimeout(
          () => reject(new Error(`Timed out acquiring server extension lock: ${stderr}`)),
          35_000
        )
      })
    ])
    return { lost, release }
  } catch (error) {
    await release().catch(() => undefined)
    signal.throwIfAborted()
    if (stderr.includes('Another active extension deployment holds the server lock'))
      throw new RemoteLockBusyError()
    throw new Error(`Could not acquire server extension lock: ${stderr}`, { cause: error })
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', cancelled)
    channel.stdout.off('data', readyData)
    channel.stderr.off('data', errorData)
    channel.stdout.resume()
    channel.stderr.resume()
  }
}
