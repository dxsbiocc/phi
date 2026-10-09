import { posix } from 'node:path'

import { isRemotePathInside } from '../remote-path-containment'
import { shellQuote, type RemoteSshSession } from '../wrappers/remote-ssh-session'
import { HelperRpcClient } from './helper-rpc'
import { WorkspaceHostError } from './types'
import type {
  AtomicWriteOptions,
  BackgroundProcessHandle,
  BackgroundProcessState,
  CommandResult,
  GlobOptions,
  HostCapabilityProfile,
  HostCommand,
  ListOptions,
  ListResult,
  ReadRangeOptions,
  ReadRangeResult,
  RemoveOptions,
  RunCommandOptions,
  WorkspaceContent,
  WorkspaceHost,
  WorkspaceStat
} from './types'

interface HelperProcessOptions {
  session: RemoteSshSession
  remotePath: string
  remoteRoot: string
  root: string
  profile: HostCapabilityProfile
  glob: WorkspaceHost['fs']['glob']
  onDisconnect?: (error: Error) => void
}

interface EncodedReadRange extends Omit<ReadRangeResult, 'content'> {
  content: string
}

interface SpawnResult {
  handleId: string
  pid: number
}

interface HelperBackgroundState extends BackgroundProcessState {
  pid: number
}

function commandParams(
  command: HostCommand,
  options: RunCommandOptions,
  cwd: string
): Record<string, unknown> {
  return {
    command: [...command],
    cwd,
    ...(options.env ? { env: { ...options.env } } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {})
  }
}

export function mapHelperWorkspacePath(
  path: string,
  remoteRoot: string,
  canonicalRoot: string
): string {
  if (
    !path ||
    path.includes('\0') ||
    path.includes('\uFFFD') ||
    /^ssh:\/\//i.test(path) ||
    path.startsWith('~/') ||
    path.split('/').includes('..')
  ) {
    throw new WorkspaceHostError('path is outside the workspace root', 'PATH_OUTSIDE_ROOT')
  }
  if (!posix.isAbsolute(path)) return path
  const normalized = posix.normalize(path)
  if (isRemotePathInside(canonicalRoot, normalized)) return normalized
  if (isRemotePathInside(remoteRoot, normalized)) {
    return posix.join(canonicalRoot, posix.relative(remoteRoot, normalized))
  }
  throw new WorkspaceHostError('path is outside the workspace root', 'PATH_OUTSIDE_ROOT')
}

function encodedContent(content: WorkspaceContent): string {
  return Buffer.from(typeof content === 'string' ? content : content).toString('base64')
}

function decodeContent(content: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    throw new Error('remote helper returned invalid base64 content')
  }
  return Buffer.from(content, 'base64')
}

export class HelperWorkspaceHost implements WorkspaceHost {
  readonly fs: WorkspaceHost['fs']
  readonly exec: WorkspaceHost['exec']
  private readonly client: HelperRpcClient

  constructor(
    private readonly session: RemoteSshSession,
    process: Awaited<ReturnType<NonNullable<RemoteSshSession['openStdio']>>>,
    private readonly profile: HostCapabilityProfile,
    glob: WorkspaceHost['fs']['glob'],
    onDisconnect: ((error: Error) => void) | undefined,
    private readonly roots: { remoteRoot: string; canonicalRoot: string }
  ) {
    this.client = new HelperRpcClient(process, { onDisconnect })
    this.fs = this.fileSystem(glob)
    this.exec = this.execution()
  }

  capabilities(): HostCapabilityProfile {
    return this.profile
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined)
    await this.session.close()
  }

  private fileSystem(glob: WorkspaceHost['fs']['glob']): WorkspaceHost['fs'] {
    const path = (value: string): string =>
      mapHelperWorkspacePath(value, this.roots.remoteRoot, this.roots.canonicalRoot)
    return {
      glob: (pattern: string, options?: GlobOptions) => glob(pattern, options),
      stat: (value: string) => this.client.request<WorkspaceStat>('fs.stat', { path: path(value) }),
      list: (value: string, options: ListOptions = {}) =>
        this.client.request<ListResult>('fs.list', { path: path(value), ...options }),
      readRange: async (value: string, options: ReadRangeOptions) => {
        const result = await this.client.request<EncodedReadRange>('fs.readRange', {
          path: path(value),
          ...options
        })
        return { ...result, content: decodeContent(result.content) }
      },
      writeAtomic: (value: string, content: WorkspaceContent, options: AtomicWriteOptions = {}) =>
        this.client.request('fs.writeAtomic', {
          path: path(value),
          content: encodedContent(content),
          ...options
        }),
      mkdirp: async (value: string) => {
        await this.client.request('fs.mkdirp', { path: path(value) })
      },
      remove: async (value: string, options: RemoveOptions = {}) => {
        await this.client.request('fs.remove', { path: path(value), ...options })
      }
    }
  }

  private execution(): WorkspaceHost['exec'] {
    return {
      run: (command, options) =>
        this.client.request<CommandResult>(
          'exec.run',
          commandParams(command, options, this.path(options.cwd)),
          { signal: options.signal, cancellable: true }
        ),
      spawnBackground: async (command, options) => {
        const spawned = await this.client.request<SpawnResult>(
          'exec.spawnBackground',
          commandParams(command, options, this.path(options.cwd))
        )
        return this.backgroundHandle(spawned)
      }
    }
  }

  private path(value: string): string {
    return mapHelperWorkspacePath(value, this.roots.remoteRoot, this.roots.canonicalRoot)
  }

  private backgroundHandle(spawned: SpawnResult): BackgroundProcessHandle {
    return {
      pid: spawned.pid,
      query: () =>
        this.client.request<HelperBackgroundState>('exec.backgroundStatus', {
          handleId: spawned.handleId
        }),
      terminate: () =>
        this.client.request<CommandResult>('exec.terminate', { handleId: spawned.handleId })
    }
  }
}

export async function openHelperWorkspaceHost(
  options: HelperProcessOptions
): Promise<HelperWorkspaceHost> {
  if (!options.session.openStdio) throw new Error('SSH transport does not support helper stdio')
  const command = `${shellQuote(options.remotePath)} serve --root ${shellQuote(options.root)}`
  const process = await options.session.openStdio(command)
  return new HelperWorkspaceHost(
    options.session,
    process,
    options.profile,
    options.glob,
    options.onDisconnect,
    { remoteRoot: options.remoteRoot, canonicalRoot: options.root }
  )
}
