import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import type { LocalRegistry, RegistryPackageEntry } from '../packages/installer-types'
import type { PackageType } from '../packages/manifest'
import { readRegistry } from '../packages/registry'
import { registryKeyId } from '../packages/signature'
import { readAdminState } from './admin-state'
import { isTeamPackError, teamPackError } from './errors'
import { sha256 } from './format'
import { writeAtomic } from './files'
import { loadTeamKeyMaterial, type SafeStorageLike } from './key-store'
import { readTeamRoster, type RosterMember } from './roster'
import {
  decryptSubmission,
  extractSubmission,
  MAX_SUBMISSION_BYTES,
  TeamSubmissionError,
  verifySubmissionRegistry,
  verifySubmissionSignature,
  type ExtractedSubmission,
  type SubmissionInvalidReason,
  type SubmissionPackageRecord
} from './submission-format'
import { assertIsoDate, assertTeamId } from './validation'

const KEYS_DIRECTORY = 'keys'
const IMPORTS_DIRECTORY = 'submission-imports'
const PENDING_DIRECTORY = 'pending-submissions'
const PENDING_METADATA_FILE = 'metadata.json'
const MAX_PENDING_METADATA_BYTES = 4 * 1024 * 1024

export interface AdminSubmissionView {
  entryId: string
  submissionId?: string
  valid: boolean
  invalidReasonCode?: SubmissionInvalidReason
  memberName?: string
  packages: SubmissionPackageRecord[]
  note?: string
  createdAt?: string
  bytes: number
}

export interface PendingSubmissionPackage extends SubmissionPackageRecord {
  title: string
  summary: string
  submissionId: string
  memberName: string
}

export interface PendingSelection {
  pendingSubmissionId: string
  type: PackageType
  id: string
}

interface PendingMetadata {
  version: 1
  submissionId: string
  memberId: string
  memberName: string
  createdAt: string
  packages: Array<SubmissionPackageRecord & { title: string; summary: string }>
}

interface SubmissionEntry {
  entryId: string
  path: string
}

interface SubmissionContext {
  directory: string
  storeDir: string | null
  identity: string
}

interface ValidatedEntry {
  view: AdminSubmissionView
  member: RosterMember
  extracted: ExtractedSubmission
  temporary: string
  entry: SubmissionEntry
}

export class TeamAdminSubmissionService {
  readonly #agentDir: string
  readonly #safeStorage: SafeStorageLike

  constructor(options: { agentDir: string; safeStorage: SafeStorageLike }) {
    if (!options.agentDir) throw teamPackError('INVALID_FORMAT', 'agentDir 不能为空')
    this.#agentDir = resolve(options.agentDir)
    this.#safeStorage = options.safeStorage
  }

  async list(teamId: string): Promise<AdminSubmissionView[]> {
    const context = this.#context(teamId)
    const views: AdminSubmissionView[] = []
    for (const entry of submissionEntries(context.directory, context.storeDir)) {
      const validated = await this.#validate(context, entry)
      views.push(validated.view)
      if ('temporary' in validated) rmSync(validated.temporary, { recursive: true, force: true })
    }
    return views.sort((left, right) => {
      const time = (right.createdAt ?? '').localeCompare(left.createdAt ?? '')
      return time || left.entryId.localeCompare(right.entryId)
    })
  }

  async import(teamId: string, sourcePath: string): Promise<AdminSubmissionView> {
    const context = this.#context(teamId)
    const stat = lstatSync(sourcePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw teamPackError('INVALID_FORMAT', '投稿导入文件必须是普通文件')
    }
    if (stat.size < 1 || stat.size > MAX_SUBMISSION_BYTES) {
      throw teamPackError('INVALID_FORMAT', '投稿文件超过大小上限')
    }
    const imports = join(context.directory, IMPORTS_DIRECTORY)
    ensurePlainDirectory(imports)
    const id = randomUUID()
    const target = join(imports, `${id}.phi-submission`)
    cpSync(sourcePath, target, { errorOnExist: true, force: false })
    const entry = { entryId: `i-${id}`, path: target }
    const validated = await this.#validate(context, entry)
    if ('temporary' in validated) rmSync(validated.temporary, { recursive: true, force: true })
    return validated.view
  }

  async accept(
    teamId: string,
    entryId: string
  ): Promise<{
    submissionId: string
    packages: SubmissionPackageRecord[]
  }> {
    const context = this.#context(teamId)
    const entry = requireEntry(context.directory, context.storeDir, entryId)
    const validated = await this.#validate(context, entry)
    if (!('temporary' in validated)) {
      throw teamPackError('INVALID_FORMAT', '无效投稿不能接受')
    }
    const submissionId = validated.extracted.manifest.submissionId
    const pendingRoot = join(context.directory, PENDING_DIRECTORY)
    ensurePlainDirectory(pendingRoot)
    const target = join(pendingRoot, submissionId)
    if (existsSync(target)) {
      rmSync(validated.temporary, { recursive: true, force: true })
      throw teamPackError('INVALID_FORMAT', '这份投稿已经在待发布区')
    }
    const staging = join(pendingRoot, `.pending-${process.pid}-${randomUUID()}`)
    try {
      mkdirSync(staging, { recursive: false, mode: 0o700 })
      cpSync(validated.extracted.registryDir, join(staging, 'registry'), {
        recursive: true,
        errorOnExist: true,
        force: false
      })
      const registry = readRegistry(join(staging, 'registry'))
      const metadata: PendingMetadata = {
        version: 1,
        submissionId,
        memberId: validated.member.memberId,
        memberName: validated.member.displayName,
        createdAt: validated.extracted.manifest.createdAt,
        packages: registry.packages.map((pkg) => ({
          type: pkg.type,
          id: pkg.id,
          version: pkg.version,
          sha256: pkg.sha256,
          title: pkg.title,
          summary: pkg.summary
        }))
      }
      writePendingMetadata(staging, metadata)
      renameSync(staging, target)
      try {
        unlinkSync(entry.path)
      } catch (error) {
        rmSync(target, { recursive: true, force: true })
        throw error
      }
      return { submissionId, packages: validated.extracted.manifest.packages }
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      if (isTeamPackError(error)) throw error
      throw teamPackError('STORE_UNAVAILABLE', '无法把投稿加入待发布区', error)
    } finally {
      rmSync(validated.temporary, { recursive: true, force: true })
    }
  }

  delete(teamId: string, entryId: string): boolean {
    const context = this.#context(teamId)
    const entry = requireEntry(context.directory, context.storeDir, entryId)
    try {
      unlinkSync(entry.path)
      return true
    } catch (error) {
      throw teamPackError('STORE_UNAVAILABLE', '无法删除投稿文件', error)
    }
  }

  listPendingPackages(teamId: string): PendingSubmissionPackage[] {
    const { directory } = this.#context(teamId)
    return listPendingMetadata(directory).flatMap((metadata) =>
      metadata.packages.map((pkg) => ({
        ...pkg,
        submissionId: metadata.submissionId,
        memberName: metadata.memberName
      }))
    )
  }

  #context(teamId: string): SubmissionContext {
    assertTeamId(teamId)
    const directory = join(this.#agentDir, 'team-pack', 'admin', teamId)
    if (!existsSync(directory) || !isPlainDirectory(directory)) {
      throw teamPackError('INVALID_FORMAT', '团队管理员目录无效')
    }
    const state = readAdminState(directory)
    const keys = loadTeamKeyMaterial({
      keyDir: join(directory, KEYS_DIRECTORY),
      safeStorage: this.#safeStorage
    })
    if (keys.teamId !== teamId || state.teamId !== teamId || state.keyId !== keys.keyId) {
      throw teamPackError('UNTRUSTED_TEAM_KEY', '团队管理员状态与投稿收件密钥不一致')
    }
    return { directory, storeDir: state.storeDir, identity: keys.submissionIdentity }
  }

  async #validate(
    context: SubmissionContext,
    entry: SubmissionEntry
  ): Promise<ValidatedEntry | { view: AdminSubmissionView }> {
    let bytes = 0
    let temporary: string | undefined
    try {
      const stat = lstatSync(entry.path)
      bytes = stat.size
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new TeamSubmissionError('format', '投稿必须是普通文件')
      }
      if (bytes < 1 || bytes > MAX_SUBMISSION_BYTES) {
        throw new TeamSubmissionError('size', '投稿超过大小上限')
      }
      const plaintext = await decryptSubmission(readFileSync(entry.path), context.identity)
      temporary = mkdtempSync(join(tmpdir(), 'phi-admin-submission-'))
      const extracted = extractSubmission(plaintext, temporary)
      if (extracted.manifest.teamId !== basename(context.directory)) {
        throw new TeamSubmissionError('team', '投稿属于另一个团队')
      }
      const member = currentSigningMember(
        readTeamRoster(context.directory).members,
        extracted.manifest.memberSigningKeyId
      )
      if (!member?.signingPublicKey) {
        throw new TeamSubmissionError('member', '签名者不是当前已登记成员')
      }
      verifySubmissionSignature(extracted, member.signingPublicKey)
      verifySubmissionRegistry(extracted.manifest, extracted.registry, temporary)
      return {
        view: {
          entryId: entry.entryId,
          submissionId: extracted.manifest.submissionId,
          valid: true,
          memberName: member.displayName,
          packages: extracted.manifest.packages,
          ...(extracted.manifest.note === undefined ? {} : { note: extracted.manifest.note }),
          createdAt: extracted.manifest.createdAt,
          bytes
        },
        member,
        extracted,
        temporary,
        entry
      }
    } catch (error) {
      if (temporary) rmSync(temporary, { recursive: true, force: true })
      const reason = error instanceof TeamSubmissionError ? error.reason : 'unknown'
      return {
        view: {
          entryId: entry.entryId,
          valid: false,
          invalidReasonCode: reason,
          packages: [],
          bytes
        }
      }
    }
  }
}

export function resolvePendingSelections(
  teamDirectory: string,
  selections: readonly PendingSelection[]
): Array<{ registry: LocalRegistry; entry: RegistryPackageEntry; metadata: PendingMetadata }> {
  const metadata = new Map(
    listPendingMetadata(teamDirectory).map((entry) => [entry.submissionId, entry])
  )
  return selections.map((selection) => {
    const pending = metadata.get(selection.pendingSubmissionId)
    const pkg = pending?.packages.find(
      (entry) => entry.type === selection.type && entry.id === selection.id
    )
    if (!pending || !pkg) throw teamPackError('INVALID_FORMAT', '找不到待发布投稿资源')
    const registry = readRegistry(
      join(teamDirectory, PENDING_DIRECTORY, selection.pendingSubmissionId, 'registry')
    )
    const entry = registry.packages.find(
      (candidate) => candidate.type === selection.type && candidate.id === selection.id
    )
    if (!entry || entry.version !== pkg.version || entry.sha256 !== pkg.sha256) {
      throw teamPackError('HASH_MISMATCH', '待发布投稿资源与接受时记录不一致')
    }
    return { registry, entry, metadata: pending }
  })
}

export function consumePendingSelections(
  teamDirectory: string,
  selections: readonly PendingSelection[]
): void {
  const bySubmission = new Map<string, Set<string>>()
  for (const selection of selections) {
    const identities = bySubmission.get(selection.pendingSubmissionId) ?? new Set<string>()
    identities.add(`${selection.type}:${selection.id}`)
    bySubmission.set(selection.pendingSubmissionId, identities)
  }
  for (const [submissionId, identities] of bySubmission) {
    const directory = join(teamDirectory, PENDING_DIRECTORY, submissionId)
    const metadata = readPendingMetadata(directory)
    const remaining = metadata.packages.filter(
      (entry) => !identities.has(`${entry.type}:${entry.id}`)
    )
    if (remaining.length === metadata.packages.length) {
      throw teamPackError('INVALID_FORMAT', '待发布投稿资源选择无效')
    }
    if (remaining.length === 0) rmSync(directory, { recursive: true, force: true })
    else writePendingMetadata(directory, { ...metadata, packages: remaining })
  }
}

function submissionEntries(teamDirectory: string, storeDir: string | null): SubmissionEntry[] {
  return [...folderSubmissionEntries(storeDir), ...importedSubmissionEntries(teamDirectory)]
}

function folderSubmissionEntries(storeDir: string | null): SubmissionEntry[] {
  if (!storeDir) return []
  const root = join(storeDir, 'submissions')
  if (!existsSync(root) || !isPlainDirectory(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((member) =>
    member.isDirectory() && !member.isSymbolicLink()
      ? memberSubmissionEntries(root, member.name)
      : []
  )
}

function memberSubmissionEntries(root: string, memberName: string): SubmissionEntry[] {
  const memberDir = join(root, memberName)
  return readdirSync(memberDir, { withFileTypes: true }).flatMap((file) => {
    if (!file.isFile() || file.isSymbolicLink()) return []
    const relative = `${memberName}/${file.name}`
    return [{ entryId: `f-${sha256(relative).slice(0, 32)}`, path: join(memberDir, file.name) }]
  })
}

function importedSubmissionEntries(teamDirectory: string): SubmissionEntry[] {
  const entries: SubmissionEntry[] = []
  const imports = join(teamDirectory, IMPORTS_DIRECTORY)
  if (existsSync(imports) && isPlainDirectory(imports)) {
    for (const file of readdirSync(imports, { withFileTypes: true })) {
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        !/^[0-9a-f-]{36}\.phi-submission$/u.test(file.name)
      )
        continue
      entries.push({
        entryId: `i-${file.name.slice(0, -'.phi-submission'.length)}`,
        path: join(imports, file.name)
      })
    }
  }
  return entries
}

function requireEntry(
  teamDirectory: string,
  storeDir: string | null,
  entryId: string
): SubmissionEntry {
  const entry = submissionEntries(teamDirectory, storeDir).find(
    (candidate) => candidate.entryId === entryId
  )
  if (!entry) throw teamPackError('INVALID_FORMAT', '找不到投稿文件')
  return entry
}

function currentSigningMember(members: RosterMember[], keyId: string): RosterMember | undefined {
  return members.find(
    (member) =>
      member.removedAt === undefined &&
      member.signingPublicKey !== undefined &&
      registryKeyId(member.signingPublicKey) === keyId
  )
}

function listPendingMetadata(teamDirectory: string): PendingMetadata[] {
  const root = join(teamDirectory, PENDING_DIRECTORY)
  if (!existsSync(root)) return []
  if (!isPlainDirectory(root)) throw teamPackError('INVALID_FORMAT', '待发布投稿目录无效')
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')
    )
    .map((entry) => {
      const metadata = readPendingMetadata(join(root, entry.name))
      if (metadata.submissionId !== entry.name) {
        throw teamPackError('INVALID_FORMAT', '待发布投稿目录与记录不一致')
      }
      return metadata
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

function readPendingMetadata(directory: string): PendingMetadata {
  let value: unknown
  try {
    const path = join(directory, PENDING_METADATA_FILE)
    const stat = lstatSync(path)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 1 ||
      stat.size > MAX_PENDING_METADATA_BYTES
    ) {
      throw new Error('invalid metadata file')
    }
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw teamPackError('INVALID_FORMAT', '待发布投稿记录无效', error)
  }
  return parsePendingMetadata(value)
}

function parsePendingMetadata(value: unknown): PendingMetadata {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'submissionId',
      'memberId',
      'memberName',
      'createdAt',
      'packages'
    ]) ||
    value.version !== 1 ||
    !Array.isArray(value.packages) ||
    value.packages.length < 1
  ) {
    throw teamPackError('INVALID_FORMAT', '待发布投稿记录无效')
  }
  if (
    !validSubmissionId(value.submissionId) ||
    !validMemberId(value.memberId) ||
    !validText(value.memberName, 100) ||
    typeof value.createdAt !== 'string'
  ) {
    throw teamPackError('INVALID_FORMAT', '待发布投稿记录无效')
  }
  assertIsoDate(value.createdAt)
  if (new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw teamPackError('INVALID_FORMAT', '待发布投稿记录时间无效')
  }
  const packages = value.packages.map(parsePendingPackage)
  return {
    version: 1,
    submissionId: value.submissionId,
    memberId: value.memberId,
    memberName: value.memberName,
    createdAt: value.createdAt,
    packages
  }
}

function parsePendingPackage(value: unknown): PendingMetadata['packages'][number] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['type', 'id', 'version', 'sha256', 'title', 'summary']) ||
    !validPackageType(value.type) ||
    !validPackageId(value.id) ||
    typeof value.version !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !validText(value.title, 80) ||
    !validText(value.summary, 300)
  ) {
    throw teamPackError('INVALID_FORMAT', '待发布投稿资源记录无效')
  }
  return value as unknown as PendingMetadata['packages'][number]
}

function validSubmissionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  )
}

function validMemberId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)
}

function validPackageType(value: unknown): value is PackageType {
  return typeof value === 'string' && ['skill', 'plugin', 'wrapper', 'mcp'].includes(value)
}

function validPackageId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{1,63}$/u.test(value)
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum
}

function writePendingMetadata(directory: string, metadata: PendingMetadata): void {
  writeAtomic(
    join(directory, PENDING_METADATA_FILE),
    Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`),
    0o600
  )
}

function isPlainDirectory(path: string): boolean {
  const stat = lstatSync(path)
  return stat.isDirectory() && !stat.isSymbolicLink()
}

function ensurePlainDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: false, mode: 0o700 })
  if (!isPlainDirectory(path)) throw teamPackError('INVALID_FORMAT', '投稿管理目录无效')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}
