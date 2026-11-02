import { CodedError } from '../../../shared/errorCodes'
import {
  connectRemoteSshSession,
  type RemoteConnectionConfig,
  type RemoteSshSession,
  type RemoteStdioProcess
} from './remote-ssh-session'

// sshd allows 10 sessions per connection by default, and each command or stdio channel takes one.
const MAX_STDIO_PER_CONNECTION = 3
const MAX_COMMANDS_PER_CONNECTION = 6
// A shared connection serves callers with different limits, so it uses the longest any of them sets.
const READY_TIMEOUT_MS = 20_000
const EXEC_TIMEOUT_MS = 30_000

type ConnectSsh = (config: RemoteConnectionConfig) => Promise<RemoteSshSession>

interface SharedConnection {
  readonly session: Promise<RemoteSshSession>
  stdioChannels: number
  commands: number
  readonly waiting: Array<() => void>
}

const connectionsByServer = new Map<string, SharedConnection[]>()

function serverKey(config: RemoteConnectionConfig): string {
  return JSON.stringify({
    ...config,
    userInitiated: undefined,
    readyTimeoutMs: undefined,
    execTimeoutMs: undefined
  })
}

function retire(key: string, shared: SharedConnection): void {
  const remaining = (connectionsByServer.get(key) ?? []).filter((entry) => entry !== shared)
  if (remaining.length > 0) connectionsByServer.set(key, remaining)
  else connectionsByServer.delete(key)
  void shared.session.then((session) => session.close()).catch(() => undefined)
}

/** A connection whose master died can't recover, so it leaves the pool and the caller gets a new one. */
async function acquire(
  key: string,
  config: RemoteConnectionConfig,
  connect: ConnectSsh,
  hasRoom: (shared: SharedConnection) => boolean
): Promise<SharedConnection> {
  for (const shared of connectionsByServer.get(key) ?? []) {
    if (!hasRoom(shared)) continue
    const alive = await shared.session.then(
      (session) => session.isAlive?.() ?? true,
      () => false
    )
    if (alive) return shared
    retire(key, shared)
  }
  const shared: SharedConnection = {
    session: connect({
      ...config,
      readyTimeoutMs: READY_TIMEOUT_MS,
      execTimeoutMs: EXEC_TIMEOUT_MS
    }),
    stdioChannels: 0,
    commands: 0,
    waiting: []
  }
  connectionsByServer.set(key, [...(connectionsByServer.get(key) ?? []), shared])
  try {
    await shared.session
  } catch (error) {
    retire(key, shared)
    throw error
  }
  return shared
}

async function runCommand<T>(shared: SharedConnection, command: () => Promise<T>): Promise<T> {
  while (shared.commands >= MAX_COMMANDS_PER_CONNECTION) {
    await new Promise<void>((resume) => shared.waiting.push(resume))
  }
  shared.commands += 1
  try {
    return await command()
  } finally {
    shared.commands -= 1
    shared.waiting.shift()?.()
  }
}

function connectionForStdio(
  primary: SharedConnection,
  key: string,
  config: RemoteConnectionConfig,
  connect: ConnectSsh
): Promise<SharedConnection> {
  const hasRoom = (candidate: SharedConnection): boolean =>
    candidate.stdioChannels < MAX_STDIO_PER_CONNECTION
  return hasRoom(primary) ? Promise.resolve(primary) : acquire(key, config, connect, hasRoom)
}

const closedError = (): CodedError =>
  new CodedError('TRANSPORT_LOST', 'SSH 连接已关闭；远端操作结果可能尚未确认')

type RunCommand = <T>(run: () => Promise<T>) => Promise<T>

function delegatedCommands(
  session: RemoteSshSession,
  command: RunCommand
): Omit<
  RemoteSshSession,
  'close' | 'openStdio' | 'openReverseTunnel' | 'isAlive' | 'remoteHelper'
> {
  return {
    exec: (remoteCommand) => command(() => session.exec(remoteCommand)),
    readTextFile: (path) => command(() => session.readTextFile(path)),
    writeTextFile: (path, content) => command(() => session.writeTextFile(path, content)),
    mkdirp: (path) => command(() => session.mkdirp(path)),
    exists: (path) => command(() => session.exists(path)),
    uploadFile: (localPath, remotePath, options) =>
      command(() => session.uploadFile(localPath, remotePath, options)),
    ...(session.readFileChunk
      ? { readFileChunk: (path, options) => command(() => session.readFileChunk!(path, options)) }
      : {}),
    ...(session.execWithInput
      ? {
          execWithInput: (remoteCommand, input, options) =>
            command(() => session.execWithInput!(remoteCommand, input, options))
        }
      : {}),
    ...(session.execBounded
      ? {
          execBounded: (remoteCommand, options) =>
            command(() => session.execBounded!(remoteCommand, options))
        }
      : {})
  }
}

/**
 * One long-lived SSH connection per server, shared by everything that talks to it. It stays open
 * while the app runs, since reconnecting to a slow server is what people wait on. Closing a
 * session ends only what that session opened. A connection whose server stops answering is
 * replaced on next use.
 */
export async function connectSharedSshSession(
  config: RemoteConnectionConfig,
  connect: ConnectSsh = connectRemoteSshSession
): Promise<RemoteSshSession> {
  const key = serverKey(config)
  const primary = await acquire(key, config, connect, () => true)
  const session = await primary.session
  const cleanups = new Set<() => Promise<void>>()
  const closedSignal = Promise.withResolvers<never>()
  closedSignal.promise.catch(() => undefined)
  let closing: Promise<void> | undefined

  const checkOpen = (): void => {
    if (closing) throw closedError()
  }
  const command = async <T>(run: () => Promise<T>): Promise<T> => {
    checkOpen()
    return Promise.race([runCommand(primary, run), closedSignal.promise])
  }

  const track = (cleanup: () => Promise<void>): (() => void) => {
    cleanups.add(cleanup)
    return () => cleanups.delete(cleanup)
  }

  const openStdio = async (remoteCommand: string): Promise<RemoteStdioProcess> => {
    checkOpen()
    const shared = await connectionForStdio(primary, key, config, connect)
    const owner = await shared.session
    if (!owner.openStdio) throw new Error('SSH transport lacks stdio support.')
    shared.stdioChannels += 1
    let channel: RemoteStdioProcess
    try {
      channel = await owner.openStdio(remoteCommand)
    } catch (error) {
      shared.stdioChannels -= 1
      throw error
    }
    const untrack = track(() => channel.close())
    void channel.closed
      .finally(() => {
        shared.stdioChannels -= 1
        untrack()
      })
      .catch(() => undefined)
    return channel
  }

  return {
    ...delegatedCommands(session, command),
    ...(session.openStdio ? { openStdio } : {}),
    ...(session.openReverseTunnel
      ? {
          openReverseTunnel: async (options) => {
            checkOpen()
            const tunnel = await session.openReverseTunnel!(options)
            const untrack = track(() => tunnel.close())
            return { ...tunnel, close: () => (untrack(), tunnel.close()) }
          }
        }
      : {}),
    isAlive: async () => !closing && ((await session.isAlive?.()) ?? true),
    close: () => {
      closing ??= (async () => {
        closedSignal.reject(closedError())
        await Promise.allSettled([...cleanups].map((cleanup) => cleanup()))
      })()
      return closing
    }
  }
}
