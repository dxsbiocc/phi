import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import {
  shellQuote,
  type RemoteSshSession,
  type RemoteUploadFileOptions
} from '../wrappers/remote-ssh-session'
import {
  REMOTE_HELPER_READY_MARKER_FILENAME,
  remoteHelperReadyMarkerSha256,
  type RemoteHelperInstallation
} from '../remote-helper-marker'
import { uploadRemoteFile } from '../transfer'
import { refreshCapabilityProfile, saveCapabilityProfile } from './capability-profile-store'
import { openHelperWorkspaceHost, type HelperWorkspaceHost } from './helper-host'
import { resolveRemoteHelperPreparation } from './helper-development'
import { installRemoteHelper, recordRemoteHelperFallback } from './helper-installer'
import { createSshExecution } from './ssh-host-exec'
import { createSshFileSystem } from './ssh-host-fs'
import type { ProbedHostCapabilityProfile } from './probe-parse'
import { SshHostContext, type SshHelperConfig, type SshHostConfig } from './ssh-host-context'
import type {
  HostCapability,
  HostCapabilityProfile,
  StatOptions,
  WorkspaceHost,
  WorkspacePortForward,
  WorkspacePty,
  WorkspaceStat,
  WorkspaceWatch
} from './types'

function unavailable(reason: string): HostCapability {
  return { state: 'unavailable', reason }
}

function workspaceProfile(profile: HostCapabilityProfile): HostCapabilityProfile {
  return {
    ...profile,
    toolchain: {
      git: profile.toolchain.git,
      nextflow: profile.toolchain.nextflow,
      java: profile.toolchain.java,
      conda: profile.toolchain.conda,
      sbatch: profile.toolchain.sbatch,
      containerRuntime: profile.toolchain.containerRuntime,
      module: profile.toolchain.module
    }
  }
}

function missingArtifactProfile(profile: ProbedHostCapabilityProfile): ProbedHostCapabilityProfile {
  const reason = 'bundled remote helper artifact is unavailable'
  const fallback = `${reason}; using pure SSH fallback`
  return {
    ...profile,
    helperCompatibility: { state: 'degraded', reason },
    fs: { state: 'degraded', reason: fallback },
    exec: { state: 'degraded', reason: fallback },
    background: { state: 'degraded', reason: fallback }
  }
}

function profileHelperInstallation(
  profile: HostCapabilityProfile | undefined
): RemoteHelperInstallation | undefined {
  const identity = profile?.helperReadyMarker
  const managedRoot = profile?.helperManagedRoot
  const remoteDirectory = profile?.helperDirectory
  if (
    !identity ||
    !managedRoot ||
    !remoteDirectory ||
    !posix.isAbsolute(managedRoot) ||
    posix.normalize(managedRoot) !== managedRoot ||
    remoteDirectory !== posix.join(managedRoot, identity.version)
  )
    return undefined
  return {
    managedRoot,
    remoteDirectory,
    remotePath: posix.join(remoteDirectory, 'phi-helper'),
    readyMarkerPath: posix.join(remoteDirectory, REMOTE_HELPER_READY_MARKER_FILENAME),
    markerIdentity: identity,
    readyMarkerSha256: remoteHelperReadyMarkerSha256(identity)
  }
}

export class SshHost implements WorkspaceHost {
  readonly fs: WorkspaceHost['fs']
  readonly exec: WorkspaceHost['exec']
  readonly pty?: WorkspacePty
  readonly watch?: WorkspaceWatch
  readonly forwardPort?: WorkspacePortForward
  readonly transfer: NonNullable<WorkspaceHost['transfer']>
  private readonly context: SshHostContext
  private readonly pureFs: WorkspaceHost['fs']
  private readonly pureExec: WorkspaceHost['exec']
  private profile: HostCapabilityProfile
  private helperProfile?: ProbedHostCapabilityProfile
  private helperConfig?: SshHelperConfig
  private helper?: HelperWorkspaceHost
  private helperRemotePath?: string
  private helperInstallation?: RemoteHelperInstallation
  private helperInitialization?: Promise<void>
  private helperDisabled = false
  private helperFailure?: string
  private disposed = false
  private readonly preparation = new AbortController()

  constructor(config: SshHostConfig) {
    this.context = new SshHostContext(config)
    this.pureFs = createSshFileSystem(this.context)
    this.pureExec = createSshExecution(this.context)
    this.fs = this.negotiatedFileSystem()
    this.exec = this.negotiatedExecution()
    this.transfer = {
      uploadFile: (local, remote, options) => this.uploadFile(local, remote, options)
    }
    this.helperProfile = config.helper?.profile
    this.helperConfig = config.helper
    this.profile = workspaceProfile(
      config.helper?.profile ?? config.capabilityProfile ?? this.pureCapabilities()
    )
    this.helperInstallation = profileHelperInstallation(config.helper?.profile)
  }

  capabilities(): HostCapabilityProfile {
    return this.profile
  }

  managedRemoteHelper(): RemoteHelperInstallation | undefined {
    return this.helperInstallation
  }

  async ensureManagedRemoteHelper(
    options: {
      force?: boolean
    } = {}
  ): Promise<RemoteHelperInstallation | undefined> {
    if (this.helperInstallation && !options.force) return this.helperInstallation
    if (options.force) {
      this.helperInstallation = undefined
      this.helperInitialization = undefined
      this.helperDisabled = false
      this.helperFailure = undefined
    }
    await this.selected(true)
    return this.helperInstallation
  }

  /** Why the managed helper could not be installed, once an install was attempted. */
  managedRemoteHelperFailure(): string | undefined {
    return this.helperInstallation ? undefined : this.helperFailure
  }

  async close(): Promise<void> {
    this.disposed = true
    this.preparation.abort()
    await this.helperInitialization?.catch(() => undefined)
    const helper = this.helper
    this.helper = undefined
    await helper?.close()
  }

  private pureCapabilities(): HostCapabilityProfile {
    const notProbed = (): HostCapability => unavailable('not probed by pure SSH SshHost')
    const notImplemented = (): HostCapability => unavailable('not implemented by pure SSH SshHost')
    return {
      platform: { ...this.context.platform },
      probedAt: new Date().toISOString(),
      fs: { state: 'available' },
      exec: { state: 'available' },
      background: { state: 'available' },
      pty: notImplemented(),
      watch: notImplemented(),
      forwardPort: notImplemented(),
      toolchain: {
        git: notProbed(),
        nextflow: notProbed(),
        java: notProbed(),
        conda: notProbed(),
        sbatch: notProbed(),
        containerRuntime: notProbed(),
        module: notProbed()
      }
    }
  }

  private negotiatedFileSystem(): WorkspaceHost['fs'] {
    return {
      glob: async (...args) => (await this.selected()).fs.glob(...args),
      list: async (...args) => (await this.selected()).fs.list(...args),
      mkdirp: async (...args) => (await this.selected()).fs.mkdirp(...args),
      readRange: async (...args) => (await this.selected()).fs.readRange(...args),
      remove: async (...args) => (await this.selected()).fs.remove(...args),
      stat: (path, options = {}) => this.stat(path, options),
      statMany: (paths) => this.pureFs.statMany!(paths),
      writeAtomic: async (...args) => (await this.selected()).fs.writeAtomic(...args)
    }
  }

  private async stat(path: string, options: StatOptions): Promise<WorkspaceStat> {
    const result = await (await this.selected()).fs.stat(path, options)
    if (!options.includeModifiedAt || result.modifiedAt) return result
    return this.pureFs.stat(path, options)
  }

  private negotiatedExecution(): WorkspaceHost['exec'] {
    return {
      run: async (...args) => (await this.selected()).exec.run(...args),
      spawnBackground: async (...args) => (await this.selected()).exec.spawnBackground(...args)
    }
  }

  private async selected(ensureHelper = false): Promise<Pick<WorkspaceHost, 'fs' | 'exec'>> {
    if (this.disposed) throw new Error('SSH workspace host is closed')
    if ((!this.context.helper && !this.context.helperBootstrap) || this.helperDisabled) {
      return { fs: this.pureFs, exec: this.pureExec }
    }
    if (
      !ensureHelper &&
      !this.helperInitialization &&
      !this.context.helper &&
      this.context.helperBootstrap?.onDemand
    ) {
      return { fs: this.pureFs, exec: this.pureExec }
    }
    this.helperInitialization ??= this.initializeHelper()
    await this.helperInitialization
    if (this.disposed) throw new Error('SSH workspace host is closed')
    return this.helper ?? { fs: this.pureFs, exec: this.pureExec }
  }

  private async initializeHelper(): Promise<void> {
    const session = await this.context.connect().catch((error) => {
      this.disableHelper(error)
      return undefined
    })
    if (!session) return
    try {
      if (this.disposed) {
        await session.close()
        return
      }
      const config = await this.resolveHelperConfig(session)
      if (!config) {
        await session.close()
        return
      }
      await this.activateHelper(session, config)
    } catch (error) {
      if (!this.disposed) this.disableHelper(error)
      await session.close().catch(() => undefined)
    }
  }

  private async activateHelper(session: RemoteSshSession, config: SshHelperConfig): Promise<void> {
    const artifact = config.prepareArtifact
      ? await config.prepareArtifact(this.preparation.signal)
      : config.artifact
    if (this.disposed) {
      await session.close()
      return
    }
    const installed = await installRemoteHelper({
      session,
      ...config,
      artifact,
      signal: this.preparation.signal
    })
    this.helperProfile = installed.profile
    this.profile = workspaceProfile(installed.profile)
    this.helperInstallation = installed.installation
    if (installed.state !== 'available' || !installed.remotePath) {
      this.helperFailure = installed.reason
      this.helperDisabled = true
      await session.close()
      return
    }
    this.helper = await openHelperWorkspaceHost({
      session,
      remotePath: installed.remotePath,
      remoteRoot: this.context.remoteRoot,
      root: this.context.canonicalRoot,
      profile: installed.profile,
      glob: this.pureFs.glob,
      onDisconnect: (error) => this.helperDisconnected(error)
    })
    this.helperRemotePath = installed.remotePath
    if (this.disposed) await this.helper.close()
  }

  private async resolveHelperConfig(
    session: Parameters<typeof refreshCapabilityProfile>[0]
  ): Promise<SshHelperConfig | undefined> {
    if (this.helperConfig) return this.helperConfig
    const bootstrap = this.context.helperBootstrap
    if (!bootstrap) return undefined
    const profile = await refreshCapabilityProfile(session, bootstrap.profileKey, {
      agentDir: bootstrap.agentDir
    })
    this.helperProfile = profile
    this.profile = workspaceProfile(profile)
    this.helperInstallation = profileHelperInstallation(profile)
    const preparation = resolveRemoteHelperPreparation(profile, {
      resourceRoot: bootstrap.resourceRoot,
      developmentRoot: bootstrap.developmentRoot
    })
    if (!preparation) {
      const fallback = missingArtifactProfile(profile)
      this.helperProfile = fallback
      this.profile = workspaceProfile(fallback)
      saveCapabilityProfile(bootstrap.profileKey, fallback, bootstrap.agentDir)
      this.helperFailure = 'bundled remote helper artifact is unavailable'
      this.helperDisabled = true
      return undefined
    }
    this.helperConfig = {
      profile,
      profileKey: bootstrap.profileKey,
      artifact: preparation.artifact,
      prepareArtifact: preparation.prepareArtifact,
      agentDir: bootstrap.agentDir
    }
    return this.helperConfig
  }

  private async uploadFile(
    localPath: string,
    remotePath: string,
    options: RemoteUploadFileOptions = {}
  ): Promise<void> {
    await this.selected()
    const rootIdentity = createHash('sha256').update(this.context.canonicalRoot).digest('hex')
    const hostKey = options.hostKey ?? this.context.transferHostKey ?? rootIdentity
    const uploadCanonicalRoot = this.context.canonicalRoot
    const transferId =
      options.transferId ??
      `workspace-${createHash('sha256')
        .update(hostKey)
        .update('\0')
        .update(remotePath)
        .update('\0')
        .update(options.expectedSha256 ?? '')
        .digest('hex')
        .slice(0, 40)}`
    await this.context.withSession(async (session) => {
      const candidate = this.context.candidate(remotePath)
      let resolvedRemotePath: string
      if (options.reuseVerifiedDestination) {
        const resolvedParent = await this.context.resolve(
          session,
          posix.dirname(candidate),
          'existing',
          options.signal
        )
        resolvedRemotePath = posix.join(resolvedParent, posix.basename(candidate))
      } else {
        resolvedRemotePath = await this.context.resolve(
          session,
          candidate,
          'create',
          options.signal
        )
      }
      const helperPath = this.helperRemotePath
      const helperConnect =
        !options.forceSsh && helperPath && session.openStdio
          ? () =>
              session.openStdio!(
                `${shellQuote(helperPath)} serve --root ${shellQuote(uploadCanonicalRoot)}`
              )
          : options.helperConnect
      await uploadRemoteFile({
        session,
        localPath,
        remotePath: resolvedRemotePath,
        remoteRoot: uploadCanonicalRoot,
        canonicalRoot: uploadCanonicalRoot,
        hostKey,
        workspaceId: options.workspaceId ?? rootIdentity,
        transferId,
        ...(options.expectedSha256 ? { expectedSha256: options.expectedSha256 } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        ...(options.coordinator ? { coordinator: options.coordinator } : {}),
        ...(options.agentDir ? { agentDir: options.agentDir } : {}),
        ...(helperConnect ? { helperConnect } : {}),
        ...(options.forceSsh ? { forceSsh: true } : {}),
        ...(options.reuseVerifiedDestination ? { reuseVerifiedDestination: true } : {}),
        ...(options.timeoutMs ? { controlTimeoutMs: options.timeoutMs } : {})
      })
    })
  }

  private helperDisconnected(error: Error): void {
    const helper = this.helper
    this.helper = undefined
    this.disableHelper(error)
    void helper?.close().catch(() => undefined)
  }

  private disableHelper(error: unknown): void {
    if (this.helperDisabled) return
    const reason = error instanceof Error ? error.message : 'remote helper transport failed'
    this.helperFailure = reason
    const config = this.helperConfig
    if (!config) return
    this.helperDisabled = true
    const fallback = recordRemoteHelperFallback(
      { ...config, profile: this.helperProfile ?? config.profile },
      reason
    )
    this.helperProfile = fallback.profile
    this.profile = workspaceProfile(fallback.profile)
  }
}
