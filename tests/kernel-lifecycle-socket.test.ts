import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createConnection, type Socket } from 'node:net'
import test from 'node:test'

import {
  isValidKernelAttachPreamble,
  listenOnKernelSocket
} from '../src/kernel/lifecycle/socket-listener'
import { KernelProtocolCore } from '../src/kernel/protocol'
import {
  PHI_KERNEL_PROTOCOL_VERSION,
  encodeFrame,
  parseFrame,
  type JsonValue,
  type KernelRequestFrame,
  type KernelResponseFrame
} from '../src/shared/kernel-protocol'

const TOKEN = '4a'.repeat(32)

test('attach preamble validation rejects protocol frames and wrong tokens', () => {
  assert.equal(
    isValidKernelAttachPreamble(JSON.stringify({ phiKernelAttach: 1, token: TOKEN }), TOKEN),
    true
  )
  assert.equal(isValidKernelAttachPreamble(JSON.stringify(hello('not-a-preamble')), TOKEN), false)
  assert.equal(
    isValidKernelAttachPreamble(
      JSON.stringify({ phiKernelAttach: 1, token: '5b'.repeat(32) }),
      TOKEN
    ),
    false
  )
  assert.equal(isValidKernelAttachPreamble('{broken', TOKEN), false)
})

function request(
  id: string,
  method: string,
  generation: number,
  params: JsonValue
): KernelRequestFrame {
  return { kind: 'request', id, method, generation, params }
}

function hello(id: string): KernelRequestFrame {
  return request(id, 'kernel.hello', 0, {
    protocol: PHI_KERNEL_PROTOCOL_VERSION,
    client: { name: 'socket-test', version: '1.0.0' }
  })
}

function connect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function readLine(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    socket.setEncoding('utf8')
    const onData = (chunk: string): void => {
      buffer += chunk
      const delimiter = buffer.indexOf('\n')
      if (delimiter === -1) return
      cleanup()
      resolve(buffer.slice(0, delimiter))
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('Socket closed before a line was received'))
    }
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('close', onClose)
    }
    socket.on('data', onData)
    socket.once('close', onClose)
  })
}

function decodeResponse(line: string): KernelResponseFrame {
  const parsed = parseFrame(line)
  if (!('kind' in parsed)) assert.fail(`expected a response, received ${parsed.code}`)
  assert.equal(parsed.kind, 'response')
  return parsed
}

test('the Unix socket requires a valid attach preamble before protocol frames', async (t) => {
  // Keep this path well below Linux's 108-byte sockaddr_un limit.
  const directory = mkdtempSync('/tmp/phi-k-test-')
  chmodSync(directory, 0o700)
  const socketPath = path.join(directory, 'kernel.sock')
  const tokenFilePath = path.join(directory, 'kernel.token')
  writeFileSync(tokenFilePath, `${TOKEN}\n`, { mode: 0o600 })

  const core = new KernelProtocolCore({
    kernelVersion: 'test-kernel',
    ompVersion: 'test-omp',
    kernelInstanceId: 'socket-kernel'
  })
  let listener
  try {
    listener = await listenOnKernelSocket({
      socketPath,
      tokenFilePath,
      onTransport: (transport) => core.attachTransport(transport, { trusted: true })
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      rmSync(directory, { recursive: true, force: true })
      t.skip('sandbox forbids Unix-domain listen(2)')
      return
    }
    throw error
  }

  try {
    const unauthenticated = await connect(socketPath)
    unauthenticated.write(encodeFrame(hello('missing-preamble')))
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Unauthenticated socket stayed open')), 500)
      unauthenticated.once('close', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    const authenticated = await connect(socketPath)
    authenticated.write(
      `${JSON.stringify({ phiKernelAttach: 1, token: TOKEN })}\n${encodeFrame(hello('hello'))}`
    )
    const response = decodeResponse(await readLine(authenticated))
    assert.equal(response.id, 'hello')
    assert.equal(response.ok, true)
    authenticated.destroy()
  } finally {
    await listener.close({ removeToken: true })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the Unix socket refuses a group-accessible runtime directory', async () => {
  const directory = mkdtempSync('/tmp/phi-k-mode-test-')
  const socketPath = path.join(directory, 'kernel.sock')
  const tokenFilePath = path.join(directory, 'kernel.token')
  writeFileSync(tokenFilePath, `${TOKEN}\n`, { mode: 0o600 })
  chmodSync(directory, 0o750)

  try {
    await assert.rejects(
      listenOnKernelSocket({ socketPath, tokenFilePath, onTransport: () => undefined }),
      /mode 0700/
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the Unix socket refuses symlinked runtime directories and token files', async () => {
  const root = mkdtempSync('/tmp/phi-k-link-test-')
  const realDirectory = path.join(root, 'real')
  const linkedDirectory = path.join(root, 'linked')
  mkdirSync(realDirectory, { mode: 0o700 })
  writeFileSync(path.join(realDirectory, 'real.token'), `${TOKEN}\n`, { mode: 0o600 })
  symlinkSync(realDirectory, linkedDirectory, 'dir')

  try {
    await assert.rejects(
      listenOnKernelSocket({
        socketPath: path.join(linkedDirectory, 'kernel.sock'),
        tokenFilePath: path.join(linkedDirectory, 'real.token'),
        onTransport: () => undefined
      }),
      /real directory/
    )

    symlinkSync(path.join(realDirectory, 'real.token'), path.join(realDirectory, 'linked.token'))
    await assert.rejects(
      listenOnKernelSocket({
        socketPath: path.join(realDirectory, 'kernel.sock'),
        tokenFilePath: path.join(realDirectory, 'linked.token'),
        onTransport: () => undefined
      }),
      /regular file/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
