import { PassThrough, Writable } from 'node:stream'
import { setImmediate as turn } from 'node:timers/promises'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcConnectionOptions, RpcTransport } from '../../src/main/agent/engine/rpc/types'

export type HostCommand = { type: string; id: string; [key: string]: unknown }
export function hostToolPeer(): {
  transport: RpcTransport
  ready(): void
  commands: HostCommand[]
  emit(frame: unknown): void
  respond(command: HostCommand, data: unknown): void
  intercept(handle: (command: HostCommand, done: (error?: Error) => void) => boolean): void
} {
  const commands: HostCommand[] = []
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let resolveClosed!: (value: { code: number | null; signal: string | null }) => void
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveClosed = resolve
  })
  let handler: ((command: HostCommand, done: (error?: Error) => void) => boolean) | undefined
  const emit = (frame: unknown): void => {
    stdout.write(JSON.stringify(frame) + '\n')
  }
  const respond = (command: HostCommand, data: unknown): void =>
    emit({
      type: 'response',
      id: command.id,
      command: command.type,
      success: true,
      data
    })
  const stdin = new Writable({
    write(bytes: Buffer, _encoding, done) {
      const command = JSON.parse(bytes.toString('utf8')) as HostCommand
      commands.push(command)
      if (handler?.(command, done)) return
      if (command.type === 'negotiate_protocol') respond(command, { protocolVersion: 2 })
      if (command.type === 'set_host_tools')
        respond(command, {
          toolNames: (command.tools as Array<{ name: string }>).map(({ name }) => name)
        })
      done()
    }
  })
  const transport: RpcTransport = {
    stdout,
    stderr,
    stdin,
    closed,
    close() {
      stdout.end()
      stderr.end()
      stdin.end()
      resolveClosed({ code: 0, signal: null })
      return Promise.resolve()
    }
  }
  return {
    transport,
    commands,
    emit,
    respond,
    ready() {
      emit({
        type: 'ready',
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1048576,
        maxReassembledFrameBytes: 67108864
      })
    },
    intercept(handle) {
      handler = handle
    }
  }
}
export async function hostToolWire(
  options: RpcConnectionOptions = {}
): Promise<ReturnType<typeof hostToolPeer> & { connection: RpcConnection }> {
  const peer = hostToolPeer()
  const connection = new RpcConnection(() => peer.transport, {
    startupTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    ...options
  })
  const started = connection.start()
  peer.ready()
  await started
  return { ...peer, connection }
}
export async function hostUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Host fixture did not reach expected state')
    await turn()
  }
}
export async function hostTurns(): Promise<void> {
  for (let i = 0; i < 4; i++) await turn()
}
