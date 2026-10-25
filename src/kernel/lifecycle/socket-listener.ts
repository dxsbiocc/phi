import { timingSafeEqual } from 'node:crypto'
import { chmod, lstat, readFile, unlink } from 'node:fs/promises'
import { isAbsolute, dirname } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'

import type { FrameTransport } from '../protocol'
import { UnixSocketFrameTransport } from '../transports/unix-socket'

const ATTACH_PREAMBLE_LIMIT_BYTES = 1024
const ATTACH_PREAMBLE_TIMEOUT_MS = 5_000
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

export type KernelSocketListener = {
  readonly socketPath: string
  close(options?: { removeToken?: boolean }): Promise<void>
}

export type ListenOnKernelSocketOptions = {
  socketPath: string
  tokenFilePath: string
  onTransport(transport: FrameTransport): void
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Kernel socket directory must be a real directory')
  }
  const uid = currentUid()
  if (uid !== undefined && info.uid !== uid) {
    throw new Error('Kernel socket directory must be owned by the current user')
  }
  if ((info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error('Kernel socket directory must have mode 0700')
  }
}

async function readPrivateToken(tokenFilePath: string): Promise<string> {
  const info = await lstat(tokenFilePath)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('Kernel token must be a regular file')
  }
  const uid = currentUid()
  if (uid !== undefined && info.uid !== uid) {
    throw new Error('Kernel token must be owned by the current user')
  }
  if ((info.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new Error('Kernel token must have mode 0600')
  }
  const token = (await readFile(tokenFilePath, 'utf8')).trim()
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error('Kernel token must contain 32 random bytes encoded as lowercase hex')
  }
  return token
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const info = await lstat(socketPath)
    if (info.isSymbolicLink() || !info.isSocket()) {
      throw new Error('Refusing to replace a non-socket kernel path')
    }
    const uid = currentUid()
    if (uid !== undefined && info.uid !== uid) {
      throw new Error('Refusing to replace a kernel socket owned by another user')
    }
    await unlink(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function tokenMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

export function isValidKernelAttachPreamble(line: string, token: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return false
  }
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as { phiKernelAttach?: unknown }).phiKernelAttach === 1 &&
    tokenMatches((parsed as { token?: unknown }).token, token)
  )
}

function authenticateSocket(
  socket: Socket,
  token: string,
  onTransport: (transport: FrameTransport) => void
): void {
  let preamble = Buffer.alloc(0)

  // A connection that never authenticates must not hold a socket slot forever.
  const deadline = setTimeout(() => socket.destroy(), ATTACH_PREAMBLE_TIMEOUT_MS)
  deadline.unref()
  socket.once('close', () => clearTimeout(deadline))
  const reject = (): void => {
    socket.destroy()
  }
  const onData = (chunk: Buffer): void => {
    preamble = Buffer.concat([preamble, chunk])
    const delimiter = preamble.indexOf(0x0a)
    if (delimiter === -1) {
      if (preamble.length > ATTACH_PREAMBLE_LIMIT_BYTES) reject()
      return
    }
    if (delimiter > ATTACH_PREAMBLE_LIMIT_BYTES) {
      reject()
      return
    }

    clearTimeout(deadline)
    socket.pause()
    socket.off('data', onData)
    if (!isValidKernelAttachPreamble(preamble.subarray(0, delimiter).toString('utf8'), token)) {
      reject()
      return
    }

    const transport = new UnixSocketFrameTransport(socket)
    try {
      onTransport(transport)
    } catch {
      transport.close()
      return
    }
    const remaining = preamble.subarray(delimiter + 1).toString('utf8')
    if (remaining) transport.receive(remaining)
    socket.resume()
  }

  socket.on('data', onData)
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })
}

export async function listenOnKernelSocket(
  options: ListenOnKernelSocketOptions
): Promise<KernelSocketListener> {
  if (!isAbsolute(options.socketPath) || !isAbsolute(options.tokenFilePath)) {
    throw new Error('Kernel socket and token paths must be absolute')
  }
  const directory = dirname(options.socketPath)
  if (dirname(options.tokenFilePath) !== directory) {
    throw new Error('Kernel socket and token must share one private directory')
  }
  await assertPrivateDirectory(directory)
  const token = await readPrivateToken(options.tokenFilePath)
  await removeStaleSocket(options.socketPath)

  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    authenticateSocket(socket, token, options.onTransport)
  })
  await listen(server, options.socketPath)
  await chmod(options.socketPath, PRIVATE_FILE_MODE)

  let closed = false
  return {
    socketPath: options.socketPath,
    async close(closeOptions = {}) {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      const remove = async (filePath: string): Promise<void> => {
        await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
      await Promise.all([
        serverClosed,
        remove(options.socketPath),
        ...(closeOptions.removeToken ? [remove(options.tokenFilePath)] : [])
      ])
    }
  }
}
