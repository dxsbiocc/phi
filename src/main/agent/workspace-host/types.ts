export type WorkspaceContent = string | Uint8Array

export interface AtomicWriteOptions {
  expectedHash?: string
}

export interface AtomicWriteResult {
  hash: string
}

export interface ReadRangeOptions {
  offset: number
  length: number
}

export interface ReadRangeResult {
  content: Uint8Array
  bytesRead: number
  eof: boolean
}

export type WorkspaceEntryKind = 'file' | 'directory' | 'symlink' | 'other'

export interface WorkspaceEntry {
  name: string
  path: string
  kind: WorkspaceEntryKind
}

export interface ListOptions {
  cursor?: string
  limit?: number
}

export interface ListResult {
  entries: readonly WorkspaceEntry[]
  nextCursor?: string
}

export interface GlobOptions {
  cwd?: string
  includeDirectories?: boolean
}

export interface WorkspaceStat {
  kind: WorkspaceEntryKind
  size: number
}

export interface RemoveOptions {
  recursive?: boolean
  force?: boolean
}

export type HostCommand = readonly [executable: string, ...args: string[]]

export interface RunCommandOptions {
  cwd: string
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
}

export interface CommandResult {
  stdout: string
  stderr: string
  code: number | null
  signal: string | null
  truncated: boolean
}

export interface BackgroundProcessState {
  pid: number
  running: boolean
  result?: CommandResult
}

export interface BackgroundProcessHandle {
  readonly pid: number
  query(): Promise<BackgroundProcessState>
  terminate(): Promise<CommandResult>
}

export type CapabilityState = 'available' | 'degraded' | 'unavailable'

export interface HostCapability {
  state: CapabilityState
  reason?: string
}

export interface HostCapabilityProfile {
  platform: {
    os: string
    arch: string
  }
  helperVersion?: string
  probedAt: string
  fs: HostCapability
  exec: HostCapability
  background: HostCapability
  pty: HostCapability
  watch: HostCapability
  forwardPort: HostCapability
  toolchain: {
    git: HostCapability
    nextflow: HostCapability
    java: HostCapability
    conda: HostCapability
    sbatch: HostCapability
    containerRuntime: HostCapability
    module: HostCapability
  }
}

export interface WorkspacePtyHandle {
  write(data: string): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  close(): Promise<void>
}

export interface WorkspacePty {
  open(options: {
    command: HostCommand
    cwd: string
    env?: Readonly<Record<string, string>>
    cols: number
    rows: number
  }): Promise<WorkspacePtyHandle>
}

export interface WorkspaceWatchEvent {
  path: string
  kind: 'created' | 'changed' | 'removed'
}

export interface WorkspaceWatchSubscription {
  close(): Promise<void>
}

export interface WorkspaceWatch {
  subscribe(
    path: string,
    listener: (event: WorkspaceWatchEvent) => void
  ): Promise<WorkspaceWatchSubscription>
}

export interface WorkspacePortForwardHandle {
  localPort: number
  close(): Promise<void>
}

export interface WorkspacePortForward {
  open(port: number): Promise<WorkspacePortForwardHandle>
}

export interface WorkspaceHost {
  fs: {
    glob(pattern: string, options?: GlobOptions): Promise<readonly string[]>
    list(path: string, options?: ListOptions): Promise<ListResult>
    mkdirp(path: string): Promise<void>
    readRange(path: string, options: ReadRangeOptions): Promise<ReadRangeResult>
    remove(path: string, options?: RemoveOptions): Promise<void>
    stat(path: string): Promise<WorkspaceStat>
    writeAtomic(
      path: string,
      content: WorkspaceContent,
      options?: AtomicWriteOptions
    ): Promise<AtomicWriteResult>
  }
  exec: {
    run(command: HostCommand, options: RunCommandOptions): Promise<CommandResult>
    spawnBackground(
      command: HostCommand,
      options: RunCommandOptions
    ): Promise<BackgroundProcessHandle>
  }
  pty?: WorkspacePty
  watch?: WorkspaceWatch
  forwardPort?: WorkspacePortForward
  capabilities(): HostCapabilityProfile
}

export class WorkspaceHostError extends Error {
  constructor(
    message: string,
    readonly code: 'HASH_MISMATCH' | 'INVALID_ARGUMENT' | 'PATH_OUTSIDE_ROOT'
  ) {
    super(message)
    this.name = 'WorkspaceHostError'
  }
}
