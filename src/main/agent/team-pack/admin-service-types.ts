import type { AdminMemberModelGrantMetadata } from './admin-grants'
import type { PublishedPreparedAdminRelease } from './admin-release'
import type { TeamPackageSelection } from './admin-selection'
import type { PendingSubmissionPackage } from './admin-submissions'
import type { RosterMember } from './roster'

export interface AdminTeamListItem {
  teamId: string
  name: string
  publicKeyFingerprint: string
}

export interface CreatedAdminTeam extends AdminTeamListItem {
  backupRequired: true
  warning: string
}

export interface PublishedAdminRelease extends PublishedPreparedAdminRelease {
  packages: Array<TeamPackageSelection & { version: string }>
}

export interface AdminTeamReleaseSummary {
  release: number
  publishedAt: string
  memberIds: string[]
  withdrawn: boolean
  hasAnnouncement: boolean
}

export interface AdminTeamSummary extends AdminTeamListItem {
  currentMemberCount: number
  modelGrants: AdminMemberModelGrantMetadata[]
  latestRelease: number | null
  releases: AdminTeamReleaseSummary[]
  withdrawnReleases: number[]
  storeDir: string | null
  pendingSubmissionPackages: PendingSubmissionPackage[]
}

export interface RemovedAdminMember extends RosterMember {
  modelKeyRevocationWarning: string
}
