import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { listInstalledPackages } from '../packages/installed'
import type { PackageType } from '../packages/manifest'
import { resolveSelections } from './admin-helpers'
import { materializeInstalledRegistry } from './admin-registry'
import { teamPackError } from './errors'
import { writeAtomic } from './files'
import type { SafeStorageLike } from './key-store'
import { loadOrCreateMemberIdentity } from './member-service'
import { listTeamSources } from './team-source-storage'
import {
  buildEncryptedSubmission,
  TeamSubmissionError,
  validateSubmissionNote,
  type BuiltSubmission
} from './submission-format'

export interface SubmissionCandidate {
  type: PackageType
  id: string
  version: string
  title: string
  summary: string
  canSubmit: boolean
  reason?: 'team-only'
}

export interface SubmissionDeliveryResult {
  submissionId: string
  delivery: 'directory' | 'export'
  path: string
}

export interface TeamMemberSubmissionServiceOptions {
  agentDir: string
  safeStorage: SafeStorageLike
  now?: () => Date
}

export class TeamMemberSubmissionService {
  readonly #agentDir: string
  readonly #safeStorage: SafeStorageLike
  readonly #now: () => Date

  constructor(options: TeamMemberSubmissionServiceOptions) {
    if (!options.agentDir) throw teamPackError('INVALID_FORMAT', 'agentDir 不能为空')
    this.#agentDir = resolve(options.agentDir)
    this.#safeStorage = options.safeStorage
    this.#now = options.now ?? (() => new Date())
  }

  listCandidates(sourceId: string): SubmissionCandidate[] {
    const source = this.#source(sourceId)
    return listInstalledPackages({ agentDir: this.#agentDir }).map((installed) => {
      const restricted =
        installed.teamSource !== undefined &&
        installed.teamSource.teamId !== source.teamId &&
        installed.teamSource.sharing === 'team-only'
      return {
        type: installed.type,
        id: installed.id,
        version: installed.version,
        title: installed.title,
        summary: installed.summary,
        canSubmit: !restricted,
        ...(restricted ? { reason: 'team-only' as const } : {})
      }
    })
  }

  async submit(
    input: {
      sourceId: string
      packages: Array<{ type: PackageType; id: string }>
      note?: string
    },
    pickExportPath: (suggestedName: string) => Promise<string | null>
  ): Promise<SubmissionDeliveryResult | null> {
    const source = this.#source(input.sourceId)
    if (!source.status.submissionRecipient) {
      throw teamPackError('INVALID_FORMAT', '这个团队尚未发布经过认证的投稿收件公钥')
    }
    const note = input.note === undefined ? undefined : validateSubmissionNote(input.note)
    const selected = resolveSelections(this.#agentDir, source.teamId, input.packages)
    const temporary = mkdtempSync(join(tmpdir(), 'phi-member-submission-'))
    try {
      const registryDir = join(temporary, 'registry')
      materializeInstalledRegistry({
        agentDir: this.#agentDir,
        teamId: source.teamId,
        installed: selected.map(({ installed }) => installed),
        registryDir,
        generatedAt: this.#timestamp()
      })
      const member = await loadOrCreateMemberIdentity({
        agentDir: this.#agentDir,
        safeStorage: this.#safeStorage
      })
      const built = await buildEncryptedSubmission({
        teamId: source.teamId,
        submissionRecipient: source.status.submissionRecipient,
        member,
        registryDir,
        createdAt: this.#timestamp(),
        ...(note === undefined ? {} : { note })
      })
      const delivered =
        source.location.kind === 'directory'
          ? tryDirectoryDelivery(source.location.path, built)
          : null
      if (delivered) {
        return { submissionId: built.submissionId, delivery: 'directory', path: delivered }
      }
      const exportPath = await pickExportPath(`${built.submissionId}.phi-submission`)
      if (exportPath === null) return null
      writeAtomic(exportPath, built.data, 0o600)
      return { submissionId: built.submissionId, delivery: 'export', path: exportPath }
    } catch (error) {
      if (error instanceof TeamSubmissionError) {
        throw teamPackError('INVALID_FORMAT', error.message, error)
      }
      throw error
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }

  #source(sourceId: string): ReturnType<typeof listTeamSources>[number] {
    const source = listTeamSources(this.#agentDir).find((entry) => entry.id === sourceId)
    if (!source) throw teamPackError('INVALID_FORMAT', '找不到团队来源')
    return source
  }

  #timestamp(): string {
    const value = this.#now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw teamPackError('INVALID_FORMAT', '投稿服务时间无效')
    }
    return value.toISOString()
  }
}

function tryDirectoryDelivery(root: string, submission: BuiltSubmission): string | null {
  const submissionsRoot = join(root, 'submissions')
  const memberRoot = join(submissionsRoot, submission.memberSigningKeyId)
  try {
    assertPlainDirectory(root)
    ensureDirectory(submissionsRoot)
    assertContainedDirectory(root, submissionsRoot)
    ensureDirectory(memberRoot)
    assertContainedDirectory(root, memberRoot)
    const target = join(realpathSync(memberRoot), `${submission.submissionId}.age`)
    writeAtomic(target, submission.data, 0o600)
    return target
  } catch {
    return null
  }
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: false, mode: 0o700 })
  assertPlainDirectory(path)
}

function assertPlainDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a plain directory')
}

function assertContainedDirectory(root: string, child: string): void {
  assertPlainDirectory(child)
  const rootPath = realpathSync(root)
  const childPath = realpathSync(child)
  const suffix = relative(rootPath, childPath)
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new Error('directory escapes source root')
  }
}

export function createTeamMemberSubmissionService(
  options: TeamMemberSubmissionServiceOptions
): TeamMemberSubmissionService {
  return new TeamMemberSubmissionService(options)
}
