import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import type { TeamResourceMap } from '../packages/installer-types'
import type { PackageType } from '../packages/manifest'
import type { AdminMemberModelGrant } from './admin-grants'
import type { AdminTeamState } from './admin-state'
import { writeAdminState } from './admin-state'
import { teamPackError } from './errors'
import { parseReleaseManifest, validateAnnouncementText, type TeamAnnouncement } from './format'
import { loadTeamKeyMaterial, type SafeStorageLike, type TeamPublicKeyMaterial } from './key-store'
import { publishTeamRelease, type MemberModelGrant, type PublishedTeamRelease } from './publish'
import { readTeamRoster, recordRosterRelease } from './roster'
import { snapshotDirectory } from './admin-helpers'

const MAX_PUBLISH_PAYLOAD_BYTES = 128 * 1024 * 1024
const SNAPSHOTS_DIRECTORY = 'registry-snapshots'

export interface AdminReleaseTeamContext {
  directory: string
  keysDirectory: string
  publicMaterial: TeamPublicKeyMaterial
  state: AdminTeamState
}

export interface PreparedPublishedPackage {
  type: PackageType
  id: string
  version: string
}

export interface PublishedPreparedAdminRelease extends PublishedTeamRelease {
  storeDir: string
  packages: PreparedPublishedPackage[]
  withdrawnReleases: number[]
}

export async function publishPreparedRegistry(input: {
  team: AdminReleaseTeamContext
  safeStorage: SafeStorageLike
  publishedAt: string
  storeDir: string
  registryDir: string
  packages: PreparedPublishedPackage[]
  grants: readonly AdminMemberModelGrant[]
  withdrawReleases: readonly number[]
  resources: TeamResourceMap
  announcement?: string
}): Promise<PublishedPreparedAdminRelease> {
  const roster = readTeamRoster(input.team.directory)
  const members = roster.members.filter((member) => member.removedAt === undefined)
  const grants = recipientGrants(members, input.grants)
  const expectedRelease = (input.team.state.latestRelease ?? 0) + 1
  const announcement =
    input.announcement === undefined ? undefined : validateAnnouncementText(input.announcement)
  const announcements = announcementHistory(
    roster.releases,
    expectedRelease,
    input.publishedAt,
    announcement
  )
  const keys = loadTeamKeyMaterial({
    keyDir: input.team.keysDirectory,
    safeStorage: input.safeStorage
  })
  const published = await publishTeamRelease({
    storeDir: input.storeDir,
    team: keys,
    members: members.map((member) => member.recipient),
    grants,
    registryDir: input.registryDir,
    createdAt: input.publishedAt,
    withdrawReleases: input.withdrawReleases,
    announcements,
    resources: input.resources
  })
  if (published.release !== expectedRelease) {
    throw teamPackError('INVALID_FORMAT', '团队发布目录与管理员发布历史不一致')
  }

  const targetSnapshot = snapshotDirectory(input.team.directory, published.release)
  if (existsSync(targetSnapshot)) {
    throw teamPackError('INVALID_FORMAT', `管理员发布内容快照 ${published.release} 已存在`)
  }
  mkdirSync(join(input.team.directory, SNAPSHOTS_DIRECTORY), { recursive: true })
  renameSync(input.registryDir, targetSnapshot)

  const manifest = parseReleaseManifest(
    readFileSync(join(input.storeDir, 'releases', String(published.release), 'manifest.json')),
    MAX_PUBLISH_PAYLOAD_BYTES
  )
  recordRosterRelease(input.team.directory, {
    release: published.release,
    publishedAt: input.publishedAt,
    memberIds: members.map((member) => member.memberId),
    withdrawn: manifest.withdrawnReleases.includes(published.release),
    resources: input.resources,
    ...(announcement === undefined ? {} : { announcement })
  })
  writeAdminState(input.team.directory, {
    version: 1,
    teamId: input.team.publicMaterial.teamId,
    keyId: input.team.publicMaterial.keyId,
    storeDir: input.storeDir,
    latestRelease: published.release,
    withdrawnReleases: manifest.withdrawnReleases
  })
  return {
    ...published,
    storeDir: input.storeDir,
    packages: input.packages,
    withdrawnReleases: manifest.withdrawnReleases
  }
}

function recipientGrants(
  members: ReturnType<typeof readTeamRoster>['members'],
  grants: readonly AdminMemberModelGrant[]
): MemberModelGrant[] {
  const memberById = new Map(members.map((member) => [member.memberId, member]))
  return grants.map((grant) => {
    const member = memberById.get(grant.memberId)
    if (!member) {
      throw teamPackError(
        'INVALID_FORMAT',
        `模型子 key 的接收成员不存在或已移除: ${grant.memberId}`
      )
    }
    return { recipient: member.recipient, models: grant.models }
  })
}

function announcementHistory(
  releases: ReturnType<typeof readTeamRoster>['releases'],
  release: number,
  publishedAt: string,
  announcement: string | undefined
): TeamAnnouncement[] {
  const history = releases.flatMap((entry) =>
    entry.announcement === undefined
      ? []
      : [{ release: entry.release, publishedAt: entry.publishedAt, text: entry.announcement }]
  )
  if (announcement !== undefined) history.push({ release, publishedAt, text: announcement })
  return history.sort((left, right) => left.release - right.release).slice(-20)
}
