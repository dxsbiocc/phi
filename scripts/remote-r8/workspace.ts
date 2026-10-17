import type { RemoteStdioProcess } from '../../src/main/agent/wrappers/remote-ssh-session'

/** One attested RPC generation of the remote OMP process. */
export interface RpcGeneration {
  readonly channel: RemoteStdioProcess
  readonly openedAt: number
  attestedAt?: number
  nonce?: string
}

export interface TimedOperation {
  readonly kind: string
  readonly elapsedMs: number
}

export interface DisconnectResult {
  readonly transport: 'ssh-master' | 'local-stdio'
  readonly pid: number | null
  readonly signal: 'SIGKILL'
  readonly physicalRpcClosed: true
  readonly elapsedMs: number
}

/**
 * The server side of one R8 run. The real implementation owns an SSH connector; the test
 * implementation runs the same cases against a local shell. Cases and cleanup only use this.
 */
export interface R8Workspace {
  /** Canonical project directory holding the seed file. */
  readonly projectRoot: string
  /** Canonical runtime root of the server. */
  readonly runtimeRoot: string
  /** True when this run created the runtime root (it is never removed). */
  readonly rootCreated: boolean
  readonly rpc: RpcGeneration[]
  /** Attested bootstrap nonces in the order they were observed. */
  readonly generations: string[]
  readonly metrics: TimedOperation[]
  /** Runs a POSIX shell script on the server; resolves with stdout, rejects on non-zero exit. */
  command(script: string): Promise<string>
  /** Reverse model tunnels opened and closed so far. */
  tunnelCounts(): Promise<{ opened: number; closed: number }>
  /** Hard-kills the transport of the latest attested RPC generation and awaits the physical close. */
  abruptDisconnectLatest(): Promise<DisconnectResult>
  /** Awaits the physical close of every RPC channel and its transport. */
  awaitRpcClosed(): Promise<void>
  /** Removes only this run's own test tree, after the ownership checks. */
  cleanupOwnedWork(): Promise<void>
  /** Closes every owned session and awaits every owned transport process. */
  close(): Promise<void>
  hasOpenChannels(): boolean
}
