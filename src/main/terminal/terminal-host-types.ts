import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export interface TerminalCreateOptions {
  terminalId: string
  application: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export interface TerminalReplayResult {
  records: Array<{ seq: number; data: string }>
  gap?: { fromSeq: number; toSeq: number; droppedBytes: number }
  nextSeq: number
  more: boolean
}

export type TerminalHostEvent =
  | { type: 'started'; terminalId: string; pid: number }
  | { type: 'data'; terminalId: string; seq: number; data: string }
  | {
      type: 'gap'
      terminalId: string
      fromSeq: number
      toSeq: number
      droppedBytes: number
    }
  | {
      type: 'exit'
      terminalId: string
      exitCode: number | null
      cancelled: boolean
      timedOut: boolean
    }
  | { type: 'failed'; terminalId: string; message: string }

export type TerminalChildSpawner = (scriptPath: string) => ChildProcessWithoutNullStreams

export interface TerminalHostOptions {
  spawnWorker?: TerminalChildSpawner
  spawnSupervisor?: TerminalChildSpawner
  workerPath?: string
  supervisorPath?: string
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  requestTimeoutMs?: number
}
