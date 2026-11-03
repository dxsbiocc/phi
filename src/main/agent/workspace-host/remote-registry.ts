import { posix } from 'node:path'

import { CodedError } from '../../../shared/errorCodes'
import {
  REMOTE_WORKSPACE_PATH_PROBE_LIMIT,
  type RemoteWorkspacePathProbeRequest,
  type RemoteWorkspacePathStat
} from '../../../shared/remoteWorkspacePath'
import { isRemotePathInside } from '../remote-path-containment'
import {
  resolveRemoteWorkspaceHostBinding,
  validRemoteAbsolutePath,
  type RemoteWorkspaceHostBinding
} from '../remote-workspace-boundary'
import { remoteMicromambaManifestVersion } from '../remote-micromamba-artifact'
import { remoteTransferHostKey } from '../transfer'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import { readCapabilityProfile } from './capability-profile-store'
import { reconcileRemoteHelperProfile } from './helper-installer'
import { resolveRemoteHelperPreparation } from './helper-development'
import { createWorkspaceHostRemoteSession } from './remote-session'
import { SshHost, SshHostClosedError } from './ssh-host'
import type { SshHostConfig } from './ssh-host-context'
import type { WorkspaceHost } from './types'
import { reportConnection } from '../connection-events'

export interface RemoteWorkspaceHostIdentity {
  sessionId: string
  projectId: string
  execTimeoutMs?: number
}

interface RemoteWorkspaceHostRegistryDependencies {
  resolveBinding?: (request: RemoteWorkspaceHostIdentity) => RemoteWorkspaceHostBinding
  createHost?: (config: SshHostConfig) => WorkspaceHost
  agentDir?: string
  helperResourceRoot?: string
  helperDevelopmentRoot?: string
  expectedMicromambaVersion?: string
  now?: () => number
  pathStatTtlMs?: number
}

const DEFAULT_PATH_STAT_TTL_MS = 2_000
const PATH_STAT_CACHE_LIMIT = 2_048

function expectedMicromambaVersion(
  dependencies: RemoteWorkspaceHostRegistryDependencies
): string | undefined {
  if (dependencies.expectedMicromambaVersion) return dependencies.expectedMicromambaVersion
  try {
    return remoteMicromambaManifestVersion()
  } catch {
    return undefined
  }
}

interface HostEntry {
  projectId: string
  cacheKey: string
  canonicalRoot: string
  host: WorkspaceHost
}

function helperBootstrapConfig(
  profileKey: { hostAlias: string; projectRoot: string },
  dependencies: RemoteWorkspaceHostRegistryDependencies
): NonNullable<SshHostConfig['helperBootstrap']> {
  return {
    profileKey,
    agentDir: dependencies.agentDir,
    resourceRoot: dependencies.helperResourceRoot,
    developmentRoot: dependencies.helperDevelopmentRoot
  }
}

function sshHostConfig(
  binding: RemoteWorkspaceHostBinding,
  dependencies: RemoteWorkspaceHostRegistryDependencies
): SshHostConfig {
  const profileKey = { hostAlias: binding.hostAlias, projectRoot: binding.remoteRoot }
  const transferHostKey = remoteTransferHostKey(binding.hostAlias)
  const cached = readCapabilityProfile(profileKey, {
    agentDir: dependencies.agentDir,
    expectedMicromambaVersion: expectedMicromambaVersion(dependencies)
  })
  const profile = cached
    ? reconcileRemoteHelperProfile(cached, {
        profileKey,
        agentDir: dependencies.agentDir,
        resourceRoot: dependencies.helperResourceRoot
      })
    : undefined
  if (!profile || profile.probe?.state === 'degraded') {
    return {
      ...binding.config,
      transferHostKey,
      capabilityProfile: profile,
      helperBootstrap: helperBootstrapConfig(profileKey, dependencies)
    }
  }
  const preparation = resolveRemoteHelperPreparation(profile, {
    resourceRoot: dependencies.helperResourceRoot,
    developmentRoot: dependencies.helperDevelopmentRoot
  })
  const artifact = preparation?.artifact
  const helperDegraded =
    profile.helperVersion === artifact?.version &&
    profile.helperStatus?.state === 'degraded' &&
    !preparation?.prepareArtifact
  return {
    ...binding.config,
    transferHostKey,
    ...(artifact && !helperDegraded
      ? {
          helper: {
            profile,
            profileKey,
            artifact,
            prepareArtifact: preparation?.prepareArtifact,
            agentDir: dependencies.agentDir
          }
        }
      : { platform: profile.platform, capabilityProfile: profile })
  }
}

function checkedPathProbeRequest(input: unknown): RemoteWorkspacePathProbeRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('远程路径探测请求无效')
  }
  const record = input as Record<string, unknown>
  if (
    Object.keys(record).some((key) => !['sessionId', 'projectId', 'paths'].includes(key)) ||
    typeof record.sessionId !== 'string' ||
    !record.sessionId ||
    Buffer.byteLength(record.sessionId, 'utf8') > 256 ||
    typeof record.projectId !== 'string' ||
    !record.projectId ||
    Buffer.byteLength(record.projectId, 'utf8') > 256 ||
    !Array.isArray(record.paths) ||
    record.paths.length > REMOTE_WORKSPACE_PATH_PROBE_LIMIT ||
    record.paths.some((path) => typeof path !== 'string')
  ) {
    throw new Error('远程路径探测请求只能包含会话、项目 ID 和路径数组（最多 64 项）')
  }
  return record as unknown as RemoteWorkspacePathProbeRequest
}

function checkedProbePaths(paths: string[], canonicalRoot: string): string[] {
  if (!validRemoteAbsolutePath(canonicalRoot) || posix.normalize(canonicalRoot) !== canonicalRoot) {
    throw new Error('远程项目根目录无效')
  }
  return paths.map((path) => {
    if (
      !validRemoteAbsolutePath(path) ||
      posix.normalize(path) !== path ||
      !isRemotePathInside(canonicalRoot, path)
    ) {
      throw new Error('远程路径探测只接受项目根目录内的规范绝对路径')
    }
    return path
  })
}

export class RemoteWorkspaceHostRegistry {
  private readonly entries = new Map<string, HostEntry>()
  /** A project's sessions share one host, so opening another session doesn't start over. */
  private readonly hostsByProject = new Map<string, HostEntry>()
  private readonly pathStats = new Map<
    string,
    { expiresAt: number; stat: RemoteWorkspacePathStat }
  >()

  constructor(private readonly dependencies: RemoteWorkspaceHostRegistryDependencies = {}) {}

  async connect(request: RemoteWorkspaceHostIdentity): Promise<RemoteSshSession> {
    const binding = (this.dependencies.resolveBinding ?? resolveRemoteWorkspaceHostBinding)({
      sessionId: request.sessionId,
      projectId: request.projectId
    })
    const entry = this.entry(binding)
    return createWorkspaceHostRemoteSession(
      this.reacquiring(binding, entry.host),
      entry.canonicalRoot,
      {
        onFailure: () => void this.retireHost(binding.cacheKey),
        defaultTimeoutMs: request.execTimeoutMs
      }
    )
  }

  /** A destructive transaction must not share the session host that cleanup can close. */
  async connectIsolated(request: RemoteWorkspaceHostIdentity): Promise<RemoteSshSession> {
    const binding = (this.dependencies.resolveBinding ?? resolveRemoteWorkspaceHostBinding)({
      sessionId: request.sessionId,
      projectId: request.projectId
    })
    const host = this.create(binding).host
    const session = createWorkspaceHostRemoteSession(host, binding.canonicalRoot, {
      defaultTimeoutMs: request.execTimeoutMs
    })
    return {
      ...session,
      async close() {
        await session.close()
        await host.close?.()
      }
    }
  }

  async statPaths(input: unknown): Promise<RemoteWorkspacePathStat[]> {
    const request = checkedPathProbeRequest(input)
    const binding = (this.dependencies.resolveBinding ?? resolveRemoteWorkspaceHostBinding)({
      sessionId: request.sessionId,
      projectId: request.projectId
    })
    const paths = checkedProbePaths(request.paths, binding.canonicalRoot)
    if (paths.length === 0) return []
    const now = (this.dependencies.now ?? Date.now)()
    const result = new Map<string, RemoteWorkspacePathStat>()
    const uncached = [...new Set(paths)].filter((path) => {
      const cached = this.pathStats.get(this.pathStatCacheKey(binding.cacheKey, path))
      if (!cached || cached.expiresAt <= now) return true
      result.set(path, cached.stat)
      return false
    })
    if (uncached.length > 0) {
      const statMany = this.entry(binding).host.fs.statMany
      if (!statMany) throw new Error('远程工作区不支持批量路径探测')
      const stats = await statMany(uncached)
      if (stats.length !== uncached.length) throw new Error('远程路径探测返回格式无效')
      const ttlMs = this.dependencies.pathStatTtlMs ?? DEFAULT_PATH_STAT_TTL_MS
      for (let index = 0; index < uncached.length; index += 1) {
        const path = uncached[index]!
        const stat = stats[index]
        if (
          !stat ||
          stat.path !== path ||
          (stat.kind !== 'file' && stat.kind !== 'directory' && stat.kind !== 'missing')
        ) {
          throw new Error('远程路径探测返回格式无效')
        }
        const value: RemoteWorkspacePathStat = { path, kind: stat.kind }
        result.set(path, value)
        this.pathStats.set(this.pathStatCacheKey(binding.cacheKey, path), {
          expiresAt: now + ttlMs,
          stat: value
        })
      }
      while (this.pathStats.size > PATH_STAT_CACHE_LIMIT) {
        const oldestKey = this.pathStats.keys().next().value
        if (!oldestKey) break
        this.pathStats.delete(oldestKey)
      }
    }
    return paths.map((path) => result.get(path)!)
  }

  /**
   * A host can be released (connection check, transport loss) between being acquired and
   * dispatching a command. Closed hosts reject before anything is sent, so one transparent
   * retry on a fresh host is safe; a second failure is reported as a lost connection.
   */
  private reacquiring(binding: RemoteWorkspaceHostBinding, first: WorkspaceHost): WorkspaceHost {
    let current = first
    const attempt = async <T>(run: (host: WorkspaceHost) => Promise<T>): Promise<T> => {
      try {
        return await run(current)
      } catch (error) {
        if (!(error instanceof SshHostClosedError)) throw error
      }
      if (this.hostsByProject.get(binding.cacheKey)?.host === current) {
        this.hostsByProject.delete(binding.cacheKey)
      }
      if (this.entries.get(binding.sessionId)?.host === current) {
        this.entries.delete(binding.sessionId)
      }
      current = this.entry(binding).host
      try {
        return await run(current)
      } catch (error) {
        if (!(error instanceof SshHostClosedError)) throw error
        throw new CodedError('TRANSPORT_LOST', 'SSH 连接中断；请检查网络和服务器后重试')
      }
    }
    const fs = first.fs
    const transfer = first.transfer
    return {
      fs: {
        glob: (...a) => attempt((h) => h.fs.glob(...a)),
        list: (...a) => attempt((h) => h.fs.list(...a)),
        mkdirp: (...a) => attempt((h) => h.fs.mkdirp(...a)),
        readRange: (...a) => attempt((h) => h.fs.readRange(...a)),
        remove: (...a) => attempt((h) => h.fs.remove(...a)),
        stat: (...a) => attempt((h) => h.fs.stat(...a)),
        ...(fs.statMany ? { statMany: (...a) => attempt((h) => h.fs.statMany!(...a)) } : {}),
        writeAtomic: (...a) => attempt((h) => h.fs.writeAtomic(...a))
      },
      exec: {
        run: (...a) => attempt((h) => h.exec.run(...a)),
        spawnBackground: (...a) => attempt((h) => h.exec.spawnBackground(...a))
      },
      ...(transfer
        ? { transfer: { uploadFile: (...a) => attempt((h) => h.transfer!.uploadFile(...a)) } }
        : {}),
      capabilities: () => current.capabilities()
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId)
    this.entries.delete(sessionId)
    if (!entry || [...this.entries.values()].includes(entry)) return
    if (this.hostsByProject.get(entry.cacheKey) === entry)
      this.hostsByProject.delete(entry.cacheKey)
    await this.closeEntry(entry, 'session_deleted')
  }

  /** A failed host fails for every session on it, so all of them move to a fresh one. */
  private async retireHost(cacheKey: string): Promise<void> {
    const entry = this.hostsByProject.get(cacheKey)
    if (!entry) return
    this.hostsByProject.delete(cacheKey)
    for (const [sessionId, current] of this.entries) {
      if (current === entry) this.entries.delete(sessionId)
    }
    await this.closeEntry(entry, 'failed')
  }

  async releaseProject(projectId: string): Promise<void> {
    const closing = new Set<HostEntry>()
    for (const [sessionId, entry] of this.entries) {
      if (entry.projectId !== projectId) continue
      this.entries.delete(sessionId)
      closing.add(entry)
    }
    for (const entry of closing) {
      if (this.hostsByProject.get(entry.cacheKey) === entry) {
        this.hostsByProject.delete(entry.cacheKey)
      }
    }
    await Promise.all([...closing].map((entry) => this.closeEntry(entry, 'project_released')))
  }

  async releaseAll(): Promise<void> {
    const closing = [...new Set(this.entries.values())].map((entry) =>
      this.closeEntry(entry, 'app_closed')
    )
    this.entries.clear()
    this.hostsByProject.clear()
    await Promise.all(closing)
    this.pathStats.clear()
  }

  private entry(binding: RemoteWorkspaceHostBinding): HostEntry {
    const current = this.entries.get(binding.sessionId)
    const entry =
      current?.projectId === binding.projectId && current.cacheKey === binding.cacheKey
        ? current
        : (this.hostsByProject.get(binding.cacheKey) ?? this.opened(binding))
    this.entries.set(binding.sessionId, entry)
    this.hostsByProject.set(binding.cacheKey, entry)
    return entry
  }

  private opened(binding: RemoteWorkspaceHostBinding): HostEntry {
    const entry = this.create(binding)
    reportConnection({ layer: 'workspace', change: 'opened', target: binding.cacheKey })
    return entry
  }

  private async closeEntry(entry: HostEntry, reason: string): Promise<void> {
    reportConnection({ layer: 'workspace', change: 'closed', target: entry.cacheKey, reason })
    await entry.host.close?.()
  }

  private pathStatCacheKey(bindingCacheKey: string, path: string): string {
    return JSON.stringify([bindingCacheKey, path])
  }

  private create(binding: RemoteWorkspaceHostBinding): HostEntry {
    const createHost = this.dependencies.createHost ?? ((input) => new SshHost(input))
    const host = createHost(sshHostConfig(binding, this.dependencies))
    // Project hosts are long-lived: bring the helper's persistent connection up on open.
    if (host instanceof SshHost) void host.warmUp()
    return {
      projectId: binding.projectId,
      cacheKey: binding.cacheKey,
      canonicalRoot: binding.canonicalRoot,
      host
    }
  }
}

export const remoteWorkspaceHosts = new RemoteWorkspaceHostRegistry()
