import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
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

export class SshHost implements WorkspaceHost {
  readonly fs: WorkspaceHost['fs']
  readonly exec: WorkspaceHost['exec']
  readonly pty?: WorkspacePty
  readonly watch?: WorkspaceWatch
  readonly forwardPort?: WorkspacePortForward
  private readonly context: SshHostContext
  private readonly pureFs: WorkspaceHost['fs']
  private readonly pureExec: WorkspaceHost['exec']
  private profile: HostCapabilityProfile
  private helperProfile?: ProbedHostCapabilityProfile
  private helperConfig?: SshHelperConfig
  private helper?: HelperWorkspaceHost
  private helperInitialization?: Promise<void>
  private helperDisabled = false
  private disposed = false
  private readonly preparation = new AbortController()

  constructor(config: SshHostConfig) {
    this.context = new SshHostContext(config)
    this.pureFs = createSshFileSystem(this.context)
    this.pureExec = createSshExecution(this.context)
    this.fs = this.negotiatedFileSystem()
    this.exec = this.negotiatedExecution()
    this.helperProfile = config.helper?.profile
    this.helperConfig = config.helper
    this.profile = workspaceProfile(
      config.helper?.profile ?? config.capabilityProfile ?? this.pureCapabilities()
    )
  }

  capabilities(): HostCapabilityProfile {
    return this.profile
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

  private async selected(): Promise<Pick<WorkspaceHost, 'fs' | 'exec'>> {
    if (this.disposed) throw new Error('SSH workspace host is closed')
    if ((!this.context.helper && !this.context.helperBootstrap) || this.helperDisabled) {
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
    const installed = await installRemoteHelper({ session, ...config, artifact })
    this.helperProfile = installed.profile
    this.profile = workspaceProfile(installed.profile)
    if (installed.state !== 'available' || !installed.remotePath) {
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
    const preparation = resolveRemoteHelperPreparation(profile, {
      resourceRoot: bootstrap.resourceRoot,
      developmentRoot: bootstrap.developmentRoot
    })
    if (!preparation) {
      const fallback = missingArtifactProfile(profile)
      this.helperProfile = fallback
      this.profile = workspaceProfile(fallback)
      saveCapabilityProfile(bootstrap.profileKey, fallback, bootstrap.agentDir)
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

  private helperDisconnected(error: Error): void {
    const helper = this.helper
    this.helper = undefined
    this.disableHelper(error)
    void helper?.close().catch(() => undefined)
  }

  private disableHelper(error: unknown): void {
    const config = this.helperConfig
    if (!config || this.helperDisabled) return
    this.helperDisabled = true
    const reason = error instanceof Error ? error.message : 'remote helper transport failed'
    const fallback = recordRemoteHelperFallback(
      { ...config, profile: this.helperProfile ?? config.profile },
      reason
    )
    this.helperProfile = fallback.profile
    this.profile = workspaceProfile(fallback.profile)
  }
}
