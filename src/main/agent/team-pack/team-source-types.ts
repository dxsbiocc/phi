import type { TeamPackErrorCode } from './errors'
import type { pullTeamRelease } from './pull'
import type { HttpTeamPackStoreOptions } from './store'

export type TeamSourceLocation =
  { kind: 'directory'; path: string } | { kind: 'https'; url: string }

export type TeamSourceErrorCode = TeamPackErrorCode | 'UNKNOWN'

export interface TeamSourceStatus {
  lastSuccessfulRelease: number | null
  lastCheckedAt: string | null
  lastErrorCode: TeamSourceErrorCode | null
  withdrawnReleases: number[]
  credentialConflicts: string[]
  skippedProviders: string[]
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

export interface TeamSourceStoredCredential {
  id: number
  provider: string
  credential: { type: string; key?: string }
}

export interface TeamSourceAuthStorage {
  credentials: {
    list(provider?: string): TeamSourceStoredCredential[]
    set(provider: string, credential: { type: 'api_key'; key: string }): Promise<void>
    removeById(provider: string, credentialId: number): Promise<boolean>
  }
  keys?: { source(provider: string): unknown }
  close?(): void
}

export interface TeamSourceServiceOptions {
  agentDir: string
  getMemberIdentity: () => Promise<string>
  authStorage?: TeamSourceAuthStorage | (() => Promise<TeamSourceAuthStorage>)
  supportedProviders?: ReadonlySet<string> | ((providerId: string) => boolean)
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
