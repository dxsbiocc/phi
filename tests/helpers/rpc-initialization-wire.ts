import { PassThrough } from 'node:stream'
import type { RpcTransport } from '../../src/main/agent/engine/rpc/types'

type Command = { type: string; id: string; [key: string]: unknown }

export function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** Synthetic wire only; lifecycle and backend/attester code stay real. */
export function createInitializationWire(
  handle?: (
    command: Command,
    respond: (data: unknown) => void,
    emit: (frame: unknown) => void
  ) => boolean,
  closeGate?: Promise<void>
): {
  transport: RpcTransport
  commands: Command[]
  emit(frame: unknown): void
  disconnect(): void
  closeCalls(): number
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const completion = deferred<{ code: number | null; signal: string | null }>()
  const commands: Command[] = []
  let closes = 0
  let closing: Promise<void> | undefined
  const emit = (frame: unknown): void => {
    stdout.write(JSON.stringify(frame) + '\n')
  }
  const finish = (code: number): void => {
    completion.resolve({ code, signal: null })
    stdin.end()
    stdout.end()
    stderr.end()
  }
  stdin.on('data', (bytes: Buffer) => {
    const command = JSON.parse(bytes.toString('utf8')) as Command
    commands.push(command)
    const respond = (data: unknown): void =>
      emit({ type: 'response', id: command.id, command: command.type, success: true, data })
    if (handle?.(command, respond, emit)) return
    respond(
      command.type === 'negotiate_protocol'
        ? { protocolVersion: 2 }
        : command.type === 'get_state'
          ? { thinkingLevel: 'off' }
          : command.type === 'get_messages'
            ? { messages: [] }
            : command.type === 'get_available_commands'
              ? { commands: [] }
              : { agentInvoked: false }
    )
  })
  queueMicrotask(() =>
    emit({
      type: 'ready',
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1024 * 1024,
      maxReassembledFrameBytes: 64 * 1024 * 1024
    })
  )
  return {
    transport: {
      stdin,
      stdout,
      stderr,
      closed: completion.promise,
      close() {
        closing ??= (async () => {
          closes++
          await closeGate
          finish(0)
        })()
        return closing
      }
    },
    commands,
    emit,
    disconnect: () => finish(1),
    closeCalls: () => closes
  }
}
