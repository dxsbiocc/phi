import { posix } from 'node:path'

import { errorCodeOf } from '../../../shared/errorCodes'
import { isRemotePathInside } from '../remote-path-containment'
import {
  RemoteWorkspaceTargetMissingError,
  resolveRemotePathOnSession,
  validRemoteAbsolutePath,
  type RemoteWorkspacePathMode
} from '../remote-workspace-boundary'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import type { CapabilityProfileKey } from './capability-profile-store'
import type { RemoteHelperArtifact } from './helper-installer'
import type { ProbedHostCapabilityProfile } from './probe-parse'
import { WorkspaceHostError, type HostCapabilityProfile } from './types'

export interface SshHelperConfig {
  profile: ProbedHostCapabilityProfile
  profileKey: CapabilityProfileKey
  artifact: RemoteHelperArtifact
  prepareArtifact?: (signal?: AbortSignal) => Promise<RemoteHelperArtifact>
  agentDir?: string
}

export interface SshHelperBootstrapConfig {
  profileKey: CapabilityProfileKey
  agentDir?: string
  resourceRoot?: string
  developmentRoot?: string
  /**
   * Leave fs/exec on pure SSH until `ensureManagedRemoteHelper()` is called, so callers that
   * never need the helper pay no probe or install. Once ensured, the helper serves fs/exec.
   */
  onDemand?: boolean
}

export interface SshHostConfig {
  remoteRoot: string
  canonicalRoot: string
  connect: () => Promise<RemoteSshSession>
  transferHostKey?: string
  platform?: { os: string; arch: string }
  capabilityProfile?: HostCapabilityProfile
  helper?: SshHelperConfig
  helperBootstrap?: SshHelperBootstrapConfig
}

function pathError(): WorkspaceHostError {
  return new WorkspaceHostError('path is outside the workspace root', 'PATH_OUTSIDE_ROOT')
}

function checkedRoot(path: string): string {
  const normalized = posix.normalize(path)
  if (!validRemoteAbsolutePath(path) || normalized !== path) {
    throw new WorkspaceHostError(
      'workspace root must be an absolute POSIX path',
      'INVALID_ARGUMENT'
    )
  }
  return normalized
}

/** OpenSSH servers default to MaxSessions 10; stay below it so a refusal never happens. */
const MAX_CONCURRENT_CHANNELS = 8
/** An unused shared connection older than this is checked for life before it is reused. */
const IDLE_LIVENESS_CHECK_MS = 30_000

interface ChannelWaiter {
  grant(): void
  reject(reason: unknown): void
}

export interface SessionUseOptions {
  /** Lets a caller queued for a channel stop waiting. */
  signal?: AbortSignal
}

/** One shared connection; `refs` counts the operations currently using it. */
interface PooledSession {
  readonly session: Promise<RemoteSshSession>
  refs: number
  lastUsedAt: number
  retired: boolean
  closing?: Promise<void>
}

export class SshHostContext {
  readonly remoteRoot: string
  readonly canonicalRoot: string
  readonly transferHostKey?: string
  readonly platform: { os: string; arch: string }
  readonly helper?: SshHelperConfig
  readonly helperBootstrap?: SshHelperBootstrapConfig
  private pooled?: PooledSession
  private disposed = false
  private activeChannels = 0
  private readonly channelWaiters: ChannelWaiter[] = []

  constructor(private readonly config: SshHostConfig) {
    this.remoteRoot = checkedRoot(config.remoteRoot)
    this.canonicalRoot = checkedRoot(config.canonicalRoot)
    this.transferHostKey = config.transferHostKey
    this.platform = config.platform ?? { os: 'remote', arch: 'unknown' }
    this.helper = config.helper
    this.helperBootstrap = config.helperBootstrap
  }

  candidate(path: string): string {
    if (
      !path ||
      path.includes('\0') ||
      path.includes('\uFFFD') ||
      /^ssh:\/\//i.test(path) ||
      path.startsWith('~/') ||
      path.split('/').includes('..')
    ) {
      throw pathError()
    }
    const candidate = posix.isAbsolute(path)
      ? posix.normalize(path)
      : posix.join(this.remoteRoot, path)
    if (
      !validRemoteAbsolutePath(candidate) ||
      (!isRemotePathInside(this.remoteRoot, candidate) &&
        !isRemotePathInside(this.canonicalRoot, candidate))
    ) {
      throw pathError()
    }
    return candidate
  }

  /**
   * Runs `operation` on the host's shared connection (ControlMaster multiplexes concurrent
   * operations). The connection opens lazily, concurrent first callers share one connect, and a
   * confirmed-dead transport retires it so the next call reconnects. After `dispose()` stragglers
   * still get a private one-shot connection.
   */
  async withSession<T>(
    operation: (session: RemoteSshSession) => Promise<T>,
    options: SessionUseOptions = {}
  ): Promise<T> {
    if (this.disposed) return this.withPrivateSession(operation)
    await this.reserveChannel(options.signal)
    try {
      const pooled = await this.usable()
      pooled.refs += 1
      try {
        return await operation(await pooled.session)
      } catch (error) {
        if (errorCodeOf(error) === 'TRANSPORT_LOST') this.retire(pooled)
        throw error
      } finally {
        pooled.refs -= 1
        pooled.lastUsedAt = Date.now()
        if (pooled.retired && pooled.refs === 0) await this.closePooled(pooled)
      }
    } finally {
      this.releaseChannel()
    }
  }

  /** The shared connection, replaced first when it sat idle long enough to have died unnoticed. */
  private async usable(): Promise<PooledSession> {
    const pooled = this.acquire()
    if (pooled.refs > 0 || Date.now() - pooled.lastUsedAt <= IDLE_LIVENESS_CHECK_MS) return pooled
    const session = await pooled.session.catch(() => undefined)
    if (!session?.isAlive || (await session.isAlive().catch(() => false))) return pooled
    this.retire(pooled)
    if (pooled.refs === 0) await this.closePooled(pooled)
    return this.acquire()
  }

  private reserveChannel(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.activeChannels < MAX_CONCURRENT_CHANNELS) {
      this.activeChannels += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.channelWaiters.splice(this.channelWaiters.indexOf(waiter), 1)
        reject(signal?.reason)
      }
      const waiter: ChannelWaiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        reject
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.channelWaiters.push(waiter)
    })
  }

  /** Hands the slot straight to the next waiter, so the count only drops when nobody waits. */
  private releaseChannel(): void {
    const next = this.channelWaiters.shift()
    if (next) next.grant()
    else this.activeChannels -= 1
  }

  /** Closes the shared connection; later operations fall back to one-shot connections. */
  async dispose(): Promise<void> {
    this.disposed = true
    const pooled = this.pooled
    if (!pooled) return
    this.retire(pooled)
    await this.closePooled(pooled)
  }

  private async withPrivateSession<T>(
    operation: (session: RemoteSshSession) => Promise<T>
  ): Promise<T> {
    const session = await this.connect()
    try {
      return await operation(session)
    } finally {
      await session.close()
    }
  }

  private acquire(): PooledSession {
    if (this.pooled) return this.pooled
    const pooled: PooledSession = {
      session: this.connect(),
      refs: 0,
      lastUsedAt: Date.now(),
      retired: false
    }
    // A failed connect is never cached: the next caller starts a fresh attempt.
    pooled.session.catch(() => this.retire(pooled))
    this.pooled = pooled
    return pooled
  }

  private retire(pooled: PooledSession): void {
    pooled.retired = true
    if (this.pooled === pooled) this.pooled = undefined
  }

  private closePooled(pooled: PooledSession): Promise<void> {
    pooled.closing ??= pooled.session.then(
      (session) => session.close().catch(() => undefined),
      () => undefined
    )
    return pooled.closing
  }

  connect(): Promise<RemoteSshSession> {
    return this.config.connect()
  }

  async resolve(
    session: RemoteSshSession,
    path: string,
    mode: RemoteWorkspacePathMode = 'existing',
    signal?: AbortSignal
  ): Promise<string> {
    const resolved = await resolveRemotePathOnSession(
      session,
      this.remoteRoot,
      this.canonicalRoot,
      this.candidate(path),
      mode,
      signal
    )
    if (!isRemotePathInside(this.canonicalRoot, resolved)) throw pathError()
    return resolved
  }

  async withPath<T>(
    path: string,
    mode: RemoteWorkspacePathMode,
    operation: (session: RemoteSshSession, resolved: string) => Promise<T>,
    options: SessionUseOptions = {}
  ): Promise<T> {
    return this.withSession(async (session) => {
      const resolved = await this.resolve(session, path, mode)
      return operation(session, resolved)
    }, options)
  }

  async mkdirp(path: string): Promise<void> {
    const candidate = this.candidate(path)
    const base = isRemotePathInside(this.canonicalRoot, candidate)
      ? this.canonicalRoot
      : this.remoteRoot
    const parts = posix.relative(base, candidate).split('/').filter(Boolean)
    await this.withSession(async (session) => {
      let current = await this.resolve(session, base, 'existing')
      for (const part of parts) current = await this.ensureDirectory(session, current, part)
    })
  }

  private async ensureDirectory(
    session: RemoteSshSession,
    parent: string,
    name: string
  ): Promise<string> {
    const candidate = posix.join(parent, name)
    try {
      return await this.resolve(session, candidate, 'existing')
    } catch (error) {
      if (!(error instanceof RemoteWorkspaceTargetMissingError)) throw error
      const target = await this.resolve(session, candidate, 'create')
      await session.mkdirp(target)
      return this.resolve(session, target, 'existing')
    }
  }
}
