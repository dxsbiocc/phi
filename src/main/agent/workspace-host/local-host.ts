import { spawnSync } from 'node:child_process'

import { createLocalExecution } from './local-exec'
import { createLocalFileSystem } from './local-fs'
import type {
  HostCapability,
  HostCapabilityProfile,
  WorkspaceHost,
  WorkspacePortForward,
  WorkspacePty,
  WorkspaceWatch
} from './types'

function localTool(names: readonly string[]): HostCapability {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which'
  for (const name of names) {
    const result = spawnSync(finder, [name], { stdio: 'ignore', timeout: 1000 })
    if (result.status === 0) return { state: 'available' }
  }
  return { state: 'unavailable', reason: `${names.join(' or ')} was not found` }
}

function unavailable(): HostCapability {
  return { state: 'unavailable', reason: 'not implemented by LocalHost' }
}

export class LocalHost implements WorkspaceHost {
  readonly fs: WorkspaceHost['fs']
  readonly exec: WorkspaceHost['exec']
  readonly pty?: WorkspacePty
  readonly watch?: WorkspaceWatch
  readonly forwardPort?: WorkspacePortForward

  constructor(root: string) {
    this.fs = createLocalFileSystem(root)
    this.exec = createLocalExecution(root)
  }

  capabilities(): HostCapabilityProfile {
    return {
      platform: { os: process.platform, arch: process.arch },
      probedAt: new Date().toISOString(),
      fs: { state: 'available' },
      exec: { state: 'available' },
      background: { state: 'available' },
      pty: unavailable(),
      watch: unavailable(),
      forwardPort: unavailable(),
      toolchain: {
        git: localTool(['git']),
        nextflow: localTool(['nextflow']),
        java: localTool(['java']),
        conda: localTool(['conda']),
        sbatch: localTool(['sbatch']),
        containerRuntime: localTool(['docker', 'podman', 'apptainer', 'singularity']),
        module: localTool(['modulecmd'])
      }
    }
  }
}
