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

export type TeamResourceSharing = 'team-only' | 'forwardable'

export interface TeamResourceOriginView {
  teamId: string
  teamName: string
  publicKeyFingerprint: string
}

export interface TeamResourceMetadataView {
  sharing: TeamResourceSharing
  originalSource?: TeamResourceOriginView
}

export interface TeamAnnouncement {
  release: number
  publishedAt: string
  text: string
}

export interface TeamSourceStatusView {
  lastSuccessfulRelease: number | null
  lastCheckedAt: string | null
  lastErrorCode: TeamSourceErrorCode | null
  withdrawnReleases: number[]
  credentialConflicts: string[]
  skippedProviders: string[]
  configuredProviders: string[]
  announcements: TeamAnnouncement[]
  resources: Record<string, TeamResourceMetadataView>
  submissionsAvailable: boolean
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
  publicKey: string
}

export interface TeamBackupPassphraseRequest {
  passphrase: string
}

export interface TeamMemberBackupImportResult {
  imported: boolean
  publicKey?: string
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
  canSubmit?: boolean
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
  hasAnnouncement: boolean
}

export interface TeamAdminDetail extends TeamAdminListItem {
  currentMemberCount: number
  latestRelease: number | null
  releases: TeamAdminRelease[]
  withdrawnReleases: number[]
  storeDir: string | null
  members: TeamAdminMember[]
  modelGrants: TeamAdminMemberModelMetadata[]
  pendingSubmissionPackages: TeamPendingSubmissionPackageView[]
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
  sharing?: TeamResourceSharing
  pendingSubmissionId?: string
}

export interface TeamPublishAdminReleaseRequest {
  teamId: string
  packages: TeamPackageSelection[]
  announcement?: string
  announcementOnly?: boolean
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

export interface TeamSubmissionCandidate {
  type: TeamPackageType
  id: string
  version: string
  title: string
  summary: string
  canSubmit: boolean
  reason?: 'team-only'
}

export interface TeamListSubmissionCandidatesRequest extends TeamSourceIdRequest {}

export interface TeamSubmitPackagesRequest extends TeamSourceIdRequest {
  packages: Array<Pick<TeamPackageSelection, 'type' | 'id'>>
  note?: string
}

export interface TeamSubmissionDeliveryResult {
  submissionId: string
  delivery: 'directory' | 'export'
  path: string
}

export interface TeamSubmissionPackageView {
  type: TeamPackageType
  id: string
  version: string
  sha256: string
}

export interface TeamPendingSubmissionPackageView extends TeamSubmissionPackageView {
  title: string
  summary: string
  submissionId: string
  memberName: string
}

export type TeamSubmissionInvalidReasonCode =
  'decrypt' | 'signature' | 'member' | 'team' | 'hash' | 'format' | 'size' | 'unknown'

export interface TeamAdminSubmissionView {
  entryId: string
  submissionId?: string
  valid: boolean
  invalidReasonCode?: TeamSubmissionInvalidReasonCode
  invalidDetail?: string
  memberName?: string
  packages: TeamSubmissionPackageView[]
  note?: string
  createdAt?: string
  bytes: number
}

export interface TeamAdminSubmissionRequest {
  teamId: string
  entryId: string
}

export interface TeamAdminSubmissionImportResult {
  imported: boolean
  submission?: TeamAdminSubmissionView
}

export interface TeamAdminSubmissionAcceptResult {
  submissionId: string
  packages: TeamSubmissionPackageView[]
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
  listSubmissionCandidates: (
    input: TeamListSubmissionCandidatesRequest
  ) => Promise<TeamPackResult<TeamSubmissionCandidate[]>>
  submitPackages: (
    input: TeamSubmitPackagesRequest
  ) => Promise<TeamPackResult<TeamSubmissionDeliveryResult | null>>
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
  listAdminSubmissions: (
    input: TeamAdminIdRequest
  ) => Promise<TeamPackResult<TeamAdminSubmissionView[]>>
  importAdminSubmission: (
    input: TeamAdminIdRequest
  ) => Promise<TeamPackResult<TeamAdminSubmissionImportResult>>
  acceptAdminSubmission: (
    input: TeamAdminSubmissionRequest
  ) => Promise<TeamPackResult<TeamAdminSubmissionAcceptResult>>
  deleteAdminSubmission: (
    input: TeamAdminSubmissionRequest
  ) => Promise<TeamPackResult<{ deleted: boolean }>>
}
