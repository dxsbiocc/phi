export type TeamPackIpcErrorCode =
  | 'NOT_A_MEMBER'
  | 'BAD_SIGNATURE'
  | 'UNTRUSTED_TEAM_KEY'
  | 'ROLLBACK'
  | 'HASH_MISMATCH'
  | 'INNER_MISMATCH'
  | 'BAD_PASSPHRASE'
  | 'RELEASE_WITHDRAWN'
  | 'STORE_UNAVAILABLE'
  | 'INVALID_FORMAT'

export interface TeamPackIpcError {
  code: TeamPackIpcErrorCode
  message: string
}

export type TeamPackResult<T> = { ok: true; value: T } | { ok: false; error: TeamPackIpcError }

export type TeamSourceLocation =
  { kind: 'directory'; path: string } | { kind: 'https'; url: string }

export type TeamSourceErrorCode = TeamPackIpcErrorCode | 'UNKNOWN'

export interface TeamSourceStatusView {
  lastSuccessfulRelease: number | null
  lastCheckedAt: string | null
  lastErrorCode: TeamSourceErrorCode | null
  withdrawnReleases: number[]
  credentialConflicts: string[]
  skippedProviders: string[]
  configuredProviders: string[]
}

export interface TeamSourceView {
  id: string
  teamId: string
  teamName: string
  publicKeyFingerprint: string
  location: TeamSourceLocation
  addedAt: string
  status: TeamSourceStatusView
}

export interface TeamSourceInput {
  location: TeamSourceLocation
  fingerprint: string
}

export interface TeamSourcePreview {
  teamId: string
  teamName: string
  publicKeyFingerprint: string
  location: TeamSourceLocation
}

export interface TeamSourceIdRequest {
  sourceId: string
}

export interface TeamMemberSnapshot {
  recipient: string
}

export interface TeamBackupPassphraseRequest {
  passphrase: string
}

export interface TeamMemberBackupImportResult {
  imported: boolean
  recipient?: string
}

export interface TeamAdminListItem {
  teamId: string
  name: string
  publicKeyFingerprint: string
}

export interface TeamCreatedAdminTeam extends TeamAdminListItem {
  backupRequired: true
  warning: string
}

export interface TeamAdminMember {
  memberId: string
  displayName: string
  recipient: string
  addedAt: string
  removedAt?: string
}

export interface TeamAdminModelMetadata {
  providerId: string
  label: string
}

export interface TeamAdminMemberModelMetadata {
  memberId: string
  models: TeamAdminModelMetadata[]
}

export interface TeamAdminRelease {
  release: number
  publishedAt: string
  memberIds: string[]
  withdrawn: boolean
}

export interface TeamAdminDetail extends TeamAdminListItem {
  currentMemberCount: number
  latestRelease: number | null
  releases: TeamAdminRelease[]
  withdrawnReleases: number[]
  storeDir: string | null
  members: TeamAdminMember[]
  modelGrants: TeamAdminMemberModelMetadata[]
}

export interface TeamAdminIdRequest {
  teamId: string
}

export interface TeamCreateAdminRequest {
  name: string
}

export interface TeamAdminBackupExportRequest extends TeamBackupPassphraseRequest {
  teamId: string
}

export interface TeamAdminBackupImportResult {
  imported: boolean
  team?: TeamAdminListItem
}

export interface TeamAddAdminMemberRequest {
  teamId: string
  displayName: string
  recipient: string
}

export interface TeamRemoveAdminMemberRequest {
  teamId: string
  memberId: string
}

export interface TeamRemovedAdminMember extends TeamAdminMember {
  modelKeyRevocationWarning: string
}

export interface TeamAdminModelInput extends TeamAdminModelMetadata {
  apiKey: string
  baseUrl?: string
}

export interface TeamSetAdminMemberModelsRequest {
  teamId: string
  memberId: string
  models: TeamAdminModelInput[]
}

export type TeamPackageType = 'skill' | 'plugin' | 'wrapper' | 'mcp'

export interface TeamPackageSelection {
  type: TeamPackageType
  id: string
}

export interface TeamPublishAdminReleaseRequest {
  teamId: string
  packages: TeamPackageSelection[]
}

export interface TeamPublishedAdminRelease {
  release: number
  payloadBytes: number
  manifestSha256: string
  storeDir: string
  packages: Array<TeamPackageSelection & { version: string }>
  withdrawnReleases: number[]
}

export interface TeamWithdrawAdminReleaseRequest {
  teamId: string
  release: number
}

export interface TeamPackRendererApi {
  getMemberSnapshot: () => Promise<TeamPackResult<TeamMemberSnapshot>>
  listSources: () => Promise<TeamPackResult<TeamSourceView[]>>
  pickSourceDirectory: () => Promise<TeamPackResult<string | null>>
  previewSource: (input: TeamSourceInput) => Promise<TeamPackResult<TeamSourcePreview>>
  addSource: (input: TeamSourceInput) => Promise<TeamPackResult<TeamSourceView>>
  checkSource: (input: TeamSourceIdRequest) => Promise<TeamPackResult<TeamSourceView>>
  removeSource: (input: TeamSourceIdRequest) => Promise<TeamPackResult<{ removed: boolean }>>
  exportMemberBackup: (
    input: TeamBackupPassphraseRequest
  ) => Promise<TeamPackResult<{ exported: boolean }>>
  importMemberBackup: (
    input: TeamBackupPassphraseRequest
  ) => Promise<TeamPackResult<TeamMemberBackupImportResult>>
  listAdminTeams: () => Promise<TeamPackResult<TeamAdminListItem[]>>
  getAdminTeam: (input: TeamAdminIdRequest) => Promise<TeamPackResult<TeamAdminDetail>>
  createAdminTeam: (input: TeamCreateAdminRequest) => Promise<TeamPackResult<TeamCreatedAdminTeam>>
  exportAdminBackup: (
    input: TeamAdminBackupExportRequest
  ) => Promise<TeamPackResult<{ exported: boolean }>>
  importAdminBackup: (
    input: TeamBackupPassphraseRequest
  ) => Promise<TeamPackResult<TeamAdminBackupImportResult>>
  addAdminMember: (input: TeamAddAdminMemberRequest) => Promise<TeamPackResult<TeamAdminMember>>
  removeAdminMember: (
    input: TeamRemoveAdminMemberRequest
  ) => Promise<TeamPackResult<TeamRemovedAdminMember>>
  setAdminMemberModels: (
    input: TeamSetAdminMemberModelsRequest
  ) => Promise<TeamPackResult<TeamAdminMemberModelMetadata>>
  publishAdminRelease: (
    input: TeamPublishAdminReleaseRequest
  ) => Promise<TeamPackResult<TeamPublishedAdminRelease | null>>
  withdrawAdminRelease: (
    input: TeamWithdrawAdminReleaseRequest
  ) => Promise<TeamPackResult<TeamPublishedAdminRelease>>
}
