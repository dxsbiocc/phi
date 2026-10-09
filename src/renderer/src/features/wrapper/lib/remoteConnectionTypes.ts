import type { RemoteHpcSettings } from '../../../../../shared/wrapperRemoteTypes'
import type { WrapperInputPathMapping } from '../../../../../shared/wrapperTypes'

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
