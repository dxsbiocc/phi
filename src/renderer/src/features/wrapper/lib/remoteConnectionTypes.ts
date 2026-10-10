import type { RemoteHpcSettings } from '../../../../../shared/wrapperRemoteTypes'
import type { WrapperInputPathMapping } from '../../../../../shared/wrapperTypes'
import type { RemoteEnvironmentToolPaths } from '../../../../../shared/remoteEnvironmentTypes'

export interface ProjectRemoteConnection {
  id: string
  label: string
  hostProfileId: string
  hpc?: RemoteHpcSettings
  runtimeRoot?: string
  inputPathMapping?: WrapperInputPathMapping
}

export interface RemoteHostProfile {
  id: string
  label: string
  hostAlias: string
  user?: string
  port?: number
  identityFile?: string
  runtimeRoot?: string
  downloadMirrorPrefix?: string
  toolPaths?: RemoteEnvironmentToolPaths
  source?: 'ssh-config'
}

export type RemoteHostProfileInput = Omit<RemoteHostProfile, 'id'> & { id?: string }

export interface OpenSshHost {
  alias: string
  hostname?: string
  user?: string
  port?: number
  identityFiles: string[]
}
