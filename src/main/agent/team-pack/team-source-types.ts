import type { TeamPackErrorCode } from './errors'
import type { TeamAnnouncement } from './format'
import type { pullTeamRelease } from './pull'
import type { HttpTeamPackStoreOptions } from './store'
import type { ModelRuntime } from '../runtime/runtime-adapter'
import type { TeamResourceMap } from '../packages/installer-types'

export type TeamSourceLocation =
  { kind: 'directory'; path: string } | { kind: 'https'; url: string }

export type TeamSourceErrorCode = TeamPackErrorCode | 'UNKNOWN'

export interface TeamSourceStatus {
  lastSuccessfulRelease: number | null
  lastCheckedAt: string | null
  lastErrorCode: TeamSourceErrorCode | null
  withdrawnReleases: number[]
  announcements: TeamAnnouncement[]
  resources: TeamResourceMap
  credentialConflicts: string[]
  skippedProviders: string[]
  submissionRecipient: string | null
}

export interface TeamSource {
  id: string
  teamId: string
  teamName: string
  teamKeyId: string
  location: TeamSourceLocation
  addedAt: string
  status: TeamSourceStatus
}

export interface TeamCredentialOwner {
  teamId: string
  providerId: string
  credentialId: number
  keySha256: string
}

export interface TeamSourcesState {
  version: 1
  sources: TeamSource[]
  credentialOwners: TeamCredentialOwner[]
}

export interface AddTeamSourceInput {
  teamKeyId: string
  location: TeamSourceLocation
}

export interface TeamSourcePreview {
  teamId: string
  teamName: string
  teamKeyId: string
  location: TeamSourceLocation
}

export type TeamSourceStoredCredential = Awaited<
  ReturnType<ModelRuntime['listCredentials']>
>[number]

export type TeamSourceAuthStorage = Pick<
  ModelRuntime,
  'getProviders' | 'getProviderAuthStatus' | 'listCredentials' | 'login' | 'logout'
>

export interface TeamSourceServiceOptions {
  agentDir: string
  getMemberIdentity: () => Promise<string>
  authStorage?: TeamSourceAuthStorage | (() => Promise<TeamSourceAuthStorage>)
  allowHttp?: boolean
  createId?: () => string
  now?: Date | (() => Date)
  httpStoreOptions?: HttpTeamPackStoreOptions
  pullRelease?: typeof pullTeamRelease
}

export interface ReconciledTeamModels {
  owners: TeamCredentialOwner[]
  conflicts: string[]
  skipped: string[]
}
