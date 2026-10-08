import { createSshExecution } from './ssh-host-exec'
import { createSshFileSystem } from './ssh-host-fs'
import { SshHostContext, type SshHostConfig } from './ssh-host-context'
import type {
  HostCapability,
  HostCapabilityProfile,
  WorkspaceHost,
  WorkspacePortForward,
  WorkspacePty,
  WorkspaceWatch
} from './types'

function unavailable(reason: string): HostCapability {
  return { state: 'unavailable', reason }
}

export class SshHost implements WorkspaceHost {
  readonly fs: WorkspaceHost['fs']
  readonly exec: WorkspaceHost['exec']
  readonly pty?: WorkspacePty
  readonly watch?: WorkspaceWatch
  readonly forwardPort?: WorkspacePortForward
  private readonly context: SshHostContext

  constructor(config: SshHostConfig) {
    this.context = new SshHostContext(config)
    this.fs = createSshFileSystem(this.context)
    this.exec = createSshExecution(this.context)
  }

  capabilities(): HostCapabilityProfile {
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
}
