import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { readRegistry } from '../packages/registry'
import type { TeamResourceMap } from '../packages/installer-types'
import { packageKey } from '../packages/installer-utils'
import type { PackageType } from '../packages/manifest'
import { ADMIN_PUBLISH_LOCK_FILE, withAdminPublishLock } from './admin-lock'
import {
  applyAdminModelGrantUpdates,
  assertAdminGrantMembersAreCurrent,
  commitPreparedAdminModelGrants,
  currentAdminModelGrantMetadata,
  deleteAdminMemberModelGrants,
  prepareAdminModelGrants,
  readCurrentAdminModelGrants,
  setAdminMemberModelGrants,
  type AdminMemberModelGrant,
  type AdminMemberModelGrantMetadata
} from './admin-grants'
import {
  consumePendingSelections,
  TeamAdminSubmissionService,
  type AdminSubmissionView
} from './admin-submissions'
import {
  materializeAdminSelections,
  pendingSelectionsFromPackages,
  type PreparedAdminRegistry,
  type TeamPackageSelection
} from './admin-selection'
import {
  initializeRoster,
  createdTeamResult,
  teamListItem,
  secureDirectory,
  assertPlainDirectory,
  pendingSnapshotDirectory,
  snapshotDirectory,
  absoluteStoreDirectory
} from './admin-helpers'
import { publishPreparedRegistry } from './admin-release'
import type {
  AdminTeamListItem,
  AdminTeamSummary,
  CreatedAdminTeam,
  PublishedAdminRelease,
  RemovedAdminMember
} from './admin-service-types'
import {
  ADMIN_STATE_FILE,
  readAdminState,
  writeAdminState,
  type AdminTeamState
} from './admin-state'
import { teamPackError } from './errors'
import type { ModelKeyGrant } from './format'
import {
  exportTeamKeyBackup,
  importTeamKeyBackup,
  loadTeamKeyMaterial,
  readTeamPublicKeyMaterial,
  storeTeamKeyMaterial,
  type SafeStorageLike,
  type TeamPublicKeyMaterial
} from './key-store'
import { createTeamKeys, parseMemberPublicKey } from './keys'
import {
  addRosterMember,
  readTeamRoster,
  removeRosterMember,
  TEAM_ROSTER_FILE_NAME,
  upgradeRosterMemberSigningKey,
  type RosterMember
} from './roster'
import { assertRelease, assertTeamId } from './validation'

const ADMIN_ROOT_PARTS = ['team-pack', 'admin'] as const
const KEYS_DIRECTORY = 'keys'
const SNAPSHOTS_DIRECTORY = 'registry-snapshots'
const PREPARED_DIRECTORY = 'prepared-registries'

export { ADMIN_PUBLISH_LOCK_FILE }
export type { AdminMemberModelGrant } from './admin-grants'

export interface TeamPackAdminServiceOptions {
  agentDir: string
  safeStorage: SafeStorageLike
  now?: () => Date
  lockWaitMs?: number
  lockRetryMs?: number
  staleLockMs?: number
}

export type { PreparedAdminRegistry, TeamPackageSelection } from './admin-selection'
export type {
  AdminTeamListItem,
  AdminTeamReleaseSummary,
  AdminTeamSummary,
  CreatedAdminTeam,
  PublishedAdminRelease,
  RemovedAdminMember
} from './admin-service-types'

export class TeamPackAdminService {
  private readonly agentDir: string
  private readonly safeStorage: SafeStorageLike
  private readonly now: () => Date
  private readonly lockWaitMs?: number
  private readonly lockRetryMs?: number
  private readonly staleLockMs?: number
  private readonly submissions: TeamAdminSubmissionService

  constructor(options: TeamPackAdminServiceOptions) {
    if (!options || typeof options.agentDir !== 'string' || options.agentDir.length === 0) {
      throw teamPackError('INVALID_FORMAT', 'agentDir 不能为空')
    }
    this.agentDir = resolve(options.agentDir)
    this.safeStorage = options.safeStorage
    this.now = options.now ?? (() => new Date())
    this.lockWaitMs = options.lockWaitMs
    this.lockRetryMs = options.lockRetryMs
    this.staleLockMs = options.staleLockMs
    this.submissions = new TeamAdminSubmissionService({
      agentDir: this.agentDir,
      safeStorage: this.safeStorage
    })
  }

  createTeam(input: { name: string; teamId?: string }): CreatedAdminTeam {
    const keys = createTeamKeys({
      name: input.name,
      ...(input.teamId ? { teamId: input.teamId } : {})
    })
    const directory = this.teamDirectory(keys.teamId)
    if (existsSync(directory)) throw teamPackError('INVALID_FORMAT', '本机已存在同标识的管理团队')

    storeTeamKeyMaterial({
      keyDir: join(directory, KEYS_DIRECTORY),
      keys,
      safeStorage: this.safeStorage
    })
    secureDirectory(directory)
    secureDirectory(join(directory, KEYS_DIRECTORY))
    initializeRoster(directory)
    writeAdminState(directory, {
      version: 1,
      teamId: keys.teamId,
      keyId: keys.keyId,
      storeDir: null,
      latestRelease: null,
      withdrawnReleases: []
    })
    return createdTeamResult(keys)
  }

  listTeams(): AdminTeamListItem[] {
    const root = this.adminRoot()
    if (!existsSync(root)) return []
    assertPlainDirectory(root, '团队管理员目录')
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => this.publicTeam(entry.name))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) || left.teamId.localeCompare(right.teamId)
      )
  }

  async exportSigningKeyBackup(input: {
    teamId: string
    backupPath: string
    passphrase: string
  }): Promise<void> {
    const { keysDirectory } = this.requireTeam(input.teamId)
    const keys = loadTeamKeyMaterial({ keyDir: keysDirectory, safeStorage: this.safeStorage })
    await exportTeamKeyBackup({
      backupPath: input.backupPath,
      keys,
      passphrase: input.passphrase
    })
  }

  async importSigningKeyBackup(input: {
    backupPath: string
    passphrase: string
  }): Promise<AdminTeamListItem> {
    const keys = await importTeamKeyBackup({
      backupPath: input.backupPath,
      passphrase: input.passphrase
    })
    const directory = this.teamDirectory(keys.teamId)
    const statePath = join(directory, ADMIN_STATE_FILE)
    const existingState = existsSync(statePath) ? readAdminState(directory) : null
    if (existingState && existingState.keyId !== keys.keyId) {
      throw teamPackError('UNTRUSTED_TEAM_KEY', '现有团队状态属于另一个签名公钥')
    }

    storeTeamKeyMaterial({
      keyDir: join(directory, KEYS_DIRECTORY),
      keys,
      safeStorage: this.safeStorage
    })
    secureDirectory(directory)
    secureDirectory(join(directory, KEYS_DIRECTORY))
    if (!existsSync(join(directory, TEAM_ROSTER_FILE_NAME))) initializeRoster(directory)
    if (!existingState) {
      writeAdminState(directory, {
        version: 1,
        teamId: keys.teamId,
        keyId: keys.keyId,
        storeDir: null,
        latestRelease: null,
        withdrawnReleases: []
      })
    }
    return teamListItem(keys)
  }

  addMember(input: { teamId: string; displayName: string; recipient: string }): RosterMember {
    const { directory } = this.requireTeam(input.teamId)
    const publicKey = parseMemberPublicKey(input.recipient)
    const existing = readTeamRoster(directory).members.find(
      (member) => member.recipient === publicKey.recipient
    )
    if (
      existing &&
      existing.removedAt === undefined &&
      existing.signingPublicKey === undefined &&
      publicKey.signingPublicKey
    ) {
      return upgradeRosterMemberSigningKey(
        directory,
        publicKey.recipient,
        publicKey.signingPublicKey
      )
    }
    return addRosterMember(directory, {
      memberId: `member-${randomUUID()}`,
      displayName: input.displayName,
      recipient: publicKey.recipient,
      ...(publicKey.signingPublicKey ? { signingPublicKey: publicKey.signingPublicKey } : {}),
      addedAt: this.timestamp()
    })
  }

  removeMember(input: { teamId: string; memberId: string }): RemovedAdminMember {
    const { directory } = this.requireTeam(input.teamId)
    const removedAt = this.timestamp()
    deleteAdminMemberModelGrants(directory, this.safeStorage, input.memberId)
    const removed = removeRosterMember(directory, input.memberId, removedAt)
    return {
      ...removed,
      modelKeyRevocationWarning: '成员已取得的模型子 key 无法远程收回；请在对应模型服务商后台吊销。'
    }
  }

  listMembers(teamId: string): RosterMember[] {
    const { directory } = this.requireTeam(teamId)
    return readTeamRoster(directory).members
  }

  listSubmissions(teamId: string): Promise<AdminSubmissionView[]> {
    return this.submissions.list(teamId)
  }

  importSubmission(input: { teamId: string; path: string }): Promise<AdminSubmissionView> {
    return this.submissions.import(input.teamId, input.path)
  }

  acceptSubmission(input: { teamId: string; entryId: string }): Promise<{
    submissionId: string
    packages: Array<{ type: PackageType; id: string; version: string; sha256: string }>
  }> {
    return this.submissions.accept(input.teamId, input.entryId)
  }

  deleteSubmission(input: { teamId: string; entryId: string }): boolean {
    return this.submissions.delete(input.teamId, input.entryId)
  }

  setMemberModelGrants(input: {
    teamId: string
    memberId: string
    models: readonly ModelKeyGrant[]
  }): AdminMemberModelGrantMetadata {
    const { directory } = this.requireTeam(input.teamId)
    return setAdminMemberModelGrants(directory, this.safeStorage, input.memberId, input.models)
  }

  deleteMemberModelGrants(input: {
    teamId: string
    memberId: string
    providerId?: string
  }): AdminMemberModelGrantMetadata {
    const { directory } = this.requireTeam(input.teamId)
    return deleteAdminMemberModelGrants(
      directory,
      this.safeStorage,
      input.memberId,
      input.providerId
    )
  }

  listMemberModelGrants(teamId: string): AdminMemberModelGrantMetadata[] {
    const { directory } = this.requireTeam(teamId)
    return currentAdminModelGrantMetadata(directory, this.safeStorage)
  }

  prepareRegistry(input: {
    teamId: string
    packages: readonly TeamPackageSelection[]
  }): PreparedAdminRegistry {
    const { directory } = this.requireTeam(input.teamId)
    const registryDir = join(directory, PREPARED_DIRECTORY, randomUUID())
    return this.materializeSelections(input.teamId, input.packages, registryDir)
  }

  async publishRelease(input: {
    teamId: string
    storeDir: string
    packages: readonly TeamPackageSelection[]
    grants?: readonly AdminMemberModelGrant[]
    withdrawReleases?: readonly number[]
    announcement?: string
    announcementOnly?: boolean
  }): Promise<PublishedAdminRelease> {
    if (input.announcementOnly !== undefined && typeof input.announcementOnly !== 'boolean') {
      throw teamPackError('INVALID_FORMAT', '公告发布标记无效')
    }
    if (input.announcementOnly === true) {
      if (input.packages.length !== 0 || input.announcement === undefined) {
        throw teamPackError('INVALID_FORMAT', '只发公告必须提供公告且不能选择资源')
      }
      if (input.grants !== undefined || (input.withdrawReleases?.length ?? 0) > 0) {
        throw teamPackError('INVALID_FORMAT', '只发公告不能同时修改子 key 或撤回版本')
      }
    }
    const storeDir = absoluteStoreDirectory(input.storeDir)
    return withAdminPublishLock(
      {
        teamId: input.teamId,
        storeDir,
        waitMs: this.lockWaitMs,
        retryMs: this.lockRetryMs,
        staleMs: this.staleLockMs,
        now: this.now
      },
      async () => {
        const team = this.requireTeam(input.teamId)
        if (team.state.storeDir !== null && team.state.storeDir !== storeDir) {
          throw teamPackError(
            'INVALID_FORMAT',
            '同一团队不能切换发布规范副本目录；请恢复原目录后继续发布'
          )
        }
        const pending = pendingSnapshotDirectory(team.directory)
        try {
          const prepared =
            input.announcementOnly === true
              ? this.copyLatestSnapshot(team, pending)
              : this.materializeSelections(input.teamId, input.packages, pending)
          const currentGrants = readCurrentAdminModelGrants(team.directory, this.safeStorage)
          if (input.grants !== undefined) {
            assertAdminGrantMembersAreCurrent(team.directory, input.grants)
          }
          const grants =
            input.grants === undefined
              ? currentGrants
              : applyAdminModelGrantUpdates(currentGrants, input.grants)
          const preparedGrants =
            input.grants === undefined
              ? undefined
              : prepareAdminModelGrants(this.safeStorage, grants)
          const published = await publishPreparedRegistry({
            team,
            safeStorage: this.safeStorage,
            publishedAt: this.timestamp(),
            storeDir,
            registryDir: prepared.registryDir,
            packages: prepared.packages,
            grants,
            withdrawReleases: input.withdrawReleases ?? [],
            resources: prepared.resources,
            ...(input.announcement === undefined ? {} : { announcement: input.announcement })
          })
          if (preparedGrants !== undefined) {
            commitPreparedAdminModelGrants(team.directory, preparedGrants)
          }
          this.consumePublishedSubmissions(team.directory, input.packages)
          return published
        } finally {
          rmSync(pending, { recursive: true, force: true })
        }
      }
    )
  }

  async withdrawRelease(input: {
    teamId: string
    release: number
  }): Promise<PublishedAdminRelease> {
    assertRelease(input.release)
    const initial = this.requireTeam(input.teamId)
    const state = initial.state
    if (state.storeDir === null || state.latestRelease === null) {
      throw teamPackError('INVALID_FORMAT', '团队尚未发布，不能撤回版本')
    }
    const storeDir = state.storeDir
    if (state.withdrawnReleases.includes(input.release)) {
      throw teamPackError('INVALID_FORMAT', `团队版本 ${input.release} 已经撤回`)
    }
    if (
      !readTeamRoster(initial.directory).releases.some((entry) => entry.release === input.release)
    ) {
      throw teamPackError('INVALID_FORMAT', `团队版本 ${input.release} 不存在`)
    }

    return withAdminPublishLock(
      {
        teamId: input.teamId,
        storeDir: state.storeDir,
        waitMs: this.lockWaitMs,
        retryMs: this.lockRetryMs,
        staleMs: this.staleLockMs,
        now: this.now
      },
      async () => {
        const team = this.requireTeam(input.teamId)
        if (team.state.storeDir !== storeDir || team.state.latestRelease === null) {
          throw teamPackError('INVALID_FORMAT', '团队发布状态已改变，请重试撤回')
        }
        const source = snapshotDirectory(team.directory, team.state.latestRelease)
        if (!existsSync(source)) {
          throw teamPackError('STORE_UNAVAILABLE', '找不到上一版发布内容快照，无法安全撤回')
        }
        readRegistry(source)
        const pending = pendingSnapshotDirectory(team.directory)
        try {
          mkdirSync(join(team.directory, SNAPSHOTS_DIRECTORY), { recursive: true })
          cpSync(source, pending, { recursive: true, errorOnExist: true, force: false })
          const registry = readRegistry(pending)
          const grants = readCurrentAdminModelGrants(team.directory, this.safeStorage)
          return await publishPreparedRegistry({
            team,
            safeStorage: this.safeStorage,
            publishedAt: this.timestamp(),
            storeDir,
            registryDir: pending,
            packages: registry.packages.map(({ type, id, version }) => ({ type, id, version })),
            grants,
            withdrawReleases: [input.release],
            resources: this.releaseResources(team.directory, team.state.latestRelease, registry)
          })
        } finally {
          rmSync(pending, { recursive: true, force: true })
        }
      }
    )
  }

  getTeamSummary(teamId: string): AdminTeamSummary {
    const team = this.requireTeam(teamId)
    const roster = readTeamRoster(team.directory)
    const currentMemberCount = roster.members.filter(
      (member) => member.removedAt === undefined
    ).length
    const withdrawn = new Set(team.state.withdrawnReleases)
    return {
      ...teamListItem(team.publicMaterial),
      currentMemberCount,
      modelGrants: currentAdminModelGrantMetadata(team.directory, this.safeStorage),
      latestRelease: team.state.latestRelease,
      releases: roster.releases.map((release) => ({
        release: release.release,
        publishedAt: release.publishedAt,
        memberIds: [...release.memberIds],
        withdrawn: withdrawn.has(release.release),
        hasAnnouncement: release.announcement !== undefined
      })),
      withdrawnReleases: [...team.state.withdrawnReleases],
      storeDir: team.state.storeDir,
      pendingSubmissionPackages: this.submissions.listPendingPackages(teamId)
    }
  }

  private materializeSelections(
    teamId: string,
    selections: readonly TeamPackageSelection[],
    registryDir: string
  ): PreparedAdminRegistry {
    const { directory } = this.requireTeam(teamId)
    return materializeAdminSelections({
      agentDir: this.agentDir,
      teamId,
      teamDirectory: directory,
      selections,
      registryDir,
      generatedAt: this.timestamp()
    })
  }

  private copyLatestSnapshot(
    team: ReturnType<TeamPackAdminService['requireTeam']>,
    pending: string
  ): PreparedAdminRegistry {
    if (team.state.latestRelease === null) {
      throw teamPackError('INVALID_FORMAT', '团队尚未发布，不能只发公告')
    }
    const source = snapshotDirectory(team.directory, team.state.latestRelease)
    if (!existsSync(source)) {
      throw teamPackError('STORE_UNAVAILABLE', '找不到上一版发布内容快照，无法只发公告')
    }
    readRegistry(source)
    mkdirSync(join(team.directory, SNAPSHOTS_DIRECTORY), { recursive: true })
    cpSync(source, pending, { recursive: true, errorOnExist: true, force: false })
    const registry = readRegistry(pending)
    return {
      registryDir: pending,
      packages: registry.packages.map(({ type, id, version }) => ({ type, id, version })),
      resources: this.releaseResources(team.directory, team.state.latestRelease, registry)
    }
  }

  private consumePublishedSubmissions(
    directory: string,
    packages: readonly TeamPackageSelection[]
  ): void {
    const pending = pendingSelectionsFromPackages(packages)
    if (pending.length > 0) consumePendingSelections(directory, pending)
  }

  private releaseResources(
    directory: string,
    release: number,
    registry: ReturnType<typeof readRegistry>
  ): TeamResourceMap {
    const recorded = readTeamRoster(directory).releases.find((entry) => entry.release === release)
    return (
      recorded?.resources ??
      Object.fromEntries(
        registry.packages.map((entry) => [packageKey(entry), { sharing: 'team-only' }])
      )
    )
  }

  private publicTeam(teamId: string): AdminTeamListItem {
    return teamListItem(this.requireTeam(teamId).publicMaterial)
  }

  private requireTeam(teamId: string): {
    directory: string
    keysDirectory: string
    publicMaterial: TeamPublicKeyMaterial
    state: AdminTeamState
  } {
    const directory = this.teamDirectory(teamId)
    assertPlainDirectory(directory, '团队管理员目录')
    const keysDirectory = join(directory, KEYS_DIRECTORY)
    const publicMaterial = readTeamPublicKeyMaterial(keysDirectory)
    const state = readAdminState(directory)
    if (
      publicMaterial.teamId !== teamId ||
      state.teamId !== teamId ||
      state.keyId !== publicMaterial.keyId
    ) {
      throw teamPackError('UNTRUSTED_TEAM_KEY', '团队管理员状态与签名公钥不一致')
    }
    readTeamRoster(directory)
    return { directory, keysDirectory, publicMaterial, state }
  }

  private adminRoot(): string {
    return join(this.agentDir, ...ADMIN_ROOT_PARTS)
  }

  private teamDirectory(teamId: string): string {
    assertTeamId(teamId)
    return join(this.adminRoot(), teamId)
  }

  private timestamp(): string {
    const value = this.now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw teamPackError('INVALID_FORMAT', '管理员服务时间无效')
    }
    return value.toISOString()
  }
}

export function createTeamPackAdminService(
  options: TeamPackAdminServiceOptions
): TeamPackAdminService {
  return new TeamPackAdminService(options)
}
