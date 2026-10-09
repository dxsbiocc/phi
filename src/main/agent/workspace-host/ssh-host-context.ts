import { posix } from 'node:path'

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


export interface SshHostConfig {
  remoteRoot: string
  canonicalRoot: string
  connect: () => Promise<RemoteSshSession>
  platform?: { os: string; arch: string }
  capabilityProfile?: HostCapabilityProfile
  helper?: SshHelperConfig
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

export class SshHostContext {
  readonly remoteRoot: string
  readonly canonicalRoot: string
  readonly platform: { os: string; arch: string }
  readonly helper?: SshHelperConfig

  constructor(private readonly config: SshHostConfig) {
    this.remoteRoot = checkedRoot(config.remoteRoot)
    this.canonicalRoot = checkedRoot(config.canonicalRoot)
    this.platform = config.platform ?? { os: 'remote', arch: 'unknown' }
    this.helper = config.helper
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

  async withSession<T>(operation: (session: RemoteSshSession) => Promise<T>): Promise<T> {
    const session = await this.connect()
    try {
      return await operation(session)
    } finally {
      await session.close()
    }
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
    operation: (session: RemoteSshSession, resolved: string) => Promise<T>
  ): Promise<T> {
    return this.withSession(async (session) => {
      const resolved = await this.resolve(session, path, mode)
      return operation(session, resolved)
    })
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
