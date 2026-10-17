import { AsyncLocalStorage } from 'node:async_hooks'

import type { RemoteSshSession } from '../../wrappers/remote-ssh-session'

export type RemoteStartupCommandChannel =
  | 'exec'
  | 'execBounded'
  | 'execWithInput'
  | 'exists'
  | 'mkdirp'
  | 'openStdio'
  | 'readFileChunk'
  | 'readTextFile'
  | 'writeTextFile'

export interface RemoteStartupDiagnosticStep {
  readonly step: string
  readonly durationMs: number
  readonly remoteCommands: number
  readonly channels: Readonly<Partial<Record<RemoteStartupCommandChannel, number>>>
}

export interface RemoteStartupDiagnostic {
  readonly phiSessionId: string
  readonly status: 'ready' | 'failed'
  readonly totalMs: number
  readonly steps: readonly RemoteStartupDiagnosticStep[]
}

export type RemoteStartupDiagnosticSink = (diagnostic: RemoteStartupDiagnostic) => void

interface MutableStep {
  durationMs: number
  remoteCommands: number
  channels: Partial<Record<RemoteStartupCommandChannel, number>>
}

interface RemoteStartupDiagnosticsOptions {
  readonly phiSessionId: string
  readonly emit: RemoteStartupDiagnosticSink
  readonly now?: () => number
}

const UNATTRIBUTED_STEP = 'unattributed'

/** Opt-in startup-only metrics. Commands, paths, output and errors never enter the report. */
export class RemoteStartupDiagnostics {
  private readonly context = new AsyncLocalStorage<string>()
  private readonly steps = new Map<string, MutableStep>()
  private readonly startedAt: number
  private readonly now: () => number
  private finished = false
  private readonly sessions = new WeakMap<RemoteSshSession, RemoteSshSession>()

  constructor(private readonly options: RemoteStartupDiagnosticsOptions) {
    this.now = options.now ?? (() => performance.now())
    this.startedAt = this.now()
  }

  async step<T>(name: string, operation: () => Promise<T>): Promise<T> {
    if (this.finished) return operation()
    const startedAt = this.now()
    this.record(name)
    try {
      return await this.context.run(name, operation)
    } finally {
      this.record(name).durationMs += Math.max(0, this.now() - startedAt)
    }
  }

  instrumentSession(session: RemoteSshSession): RemoteSshSession {
    const existing = this.sessions.get(session)
    if (existing) return existing
    const command = <T>(
      channel: RemoteStartupCommandChannel,
      operation: () => Promise<T>
    ): Promise<T> => {
      this.remoteCommand(channel)
      return operation()
    }
    const wrapped: RemoteSshSession = {
      exec: (value) => command('exec', () => session.exec(value)),
      readTextFile: (path) => command('readTextFile', () => session.readTextFile(path)),
      writeTextFile: (path, content) =>
        command('writeTextFile', () => session.writeTextFile(path, content)),
      mkdirp: (path) => command('mkdirp', () => session.mkdirp(path)),
      exists: (path) => command('exists', () => session.exists(path)),
      uploadFile: (localPath, remotePath, options) =>
        session.uploadFile(localPath, remotePath, options),
      close: () => session.close(),
      ...(session.readFileChunk
        ? {
            readFileChunk: (path, options) =>
              command('readFileChunk', () => session.readFileChunk!(path, options))
          }
        : {}),
      ...(session.execWithInput
        ? {
            execWithInput: (value, input, options) =>
              command('execWithInput', () => session.execWithInput!(value, input, options))
          }
        : {}),
      ...(session.execBounded
        ? {
            execBounded: (value, options) =>
              command('execBounded', () => session.execBounded!(value, options))
          }
        : {}),
      ...(session.openStdio
        ? {
            openStdio: (value) => command('openStdio', () => session.openStdio!(value))
          }
        : {}),
      ...(session.openReverseTunnel
        ? {
            openReverseTunnel: (options) => session.openReverseTunnel!(options)
          }
        : {})
    }
    this.sessions.set(session, wrapped)
    this.sessions.set(wrapped, wrapped)
    return wrapped
  }

  finish(status: RemoteStartupDiagnostic['status']): void {
    if (this.finished) return
    this.finished = true
    const diagnostic: RemoteStartupDiagnostic = Object.freeze({
      phiSessionId: this.options.phiSessionId,
      status,
      totalMs: this.duration(this.now() - this.startedAt),
      steps: Object.freeze(
        [...this.steps].map(([step, value]) =>
          Object.freeze({
            step,
            durationMs: this.duration(value.durationMs),
            remoteCommands: value.remoteCommands,
            channels: Object.freeze({ ...value.channels })
          })
        )
      )
    })
    try {
      this.options.emit(diagnostic)
    } catch {
      // Diagnostics must never alter startup or recovery behavior.
    }
  }

  private remoteCommand(channel: RemoteStartupCommandChannel): void {
    if (this.finished) return
    const step = this.record(this.context.getStore() ?? UNATTRIBUTED_STEP)
    step.remoteCommands++
    step.channels[channel] = (step.channels[channel] ?? 0) + 1
  }

  private record(name: string): MutableStep {
    let step = this.steps.get(name)
    if (!step) {
      step = { durationMs: 0, remoteCommands: 0, channels: {} }
      this.steps.set(name, step)
    }
    return step
  }

  private duration(value: number): number {
    return Math.round(Math.max(0, value) * 1000) / 1000
  }
}
