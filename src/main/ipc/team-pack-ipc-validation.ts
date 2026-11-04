import type { TeamSourceInput } from '../../shared/teamPackTypes'
import type { TeamPackageSelection } from '../agent/team-pack/admin-service'
import { teamPackError } from '../agent/team-pack/errors'
import { parseMemberPublicKey } from '../agent/team-pack/keys'
import {
  validateAnnouncementText,
  validateModelKeyGrants,
  type ModelKeyGrant
} from '../agent/team-pack/format'
import type { AddTeamSourceInput } from '../agent/team-pack/team-source'
import { assertRelease, assertTeamId, assertTeamName } from '../agent/team-pack/validation'

export function sourceInput(value: unknown): AddTeamSourceInput {
  if (!isRecord(value) || !hasExactKeys(value, ['location', 'fingerprint'])) invalidInput()
  if (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{16}$/.test(value.fingerprint)) {
    invalidInput()
  }
  return {
    teamKeyId: value.fingerprint,
    location: sourceLocation(value.location)
  }
}

export function sourceIdInput(value: unknown): string {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['sourceId']) ||
    typeof value.sourceId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.sourceId)
  ) {
    invalidInput()
  }
  return value.sourceId
}

export function submitPackagesInput(value: unknown): {
  sourceId: string
  packages: Array<Pick<TeamPackageSelection, 'type' | 'id'>>
  note?: string
} {
  if (!isRecord(value)) invalidInput()
  const expected =
    value.note === undefined ? ['sourceId', 'packages'] : ['sourceId', 'packages', 'note']
  if (
    !hasExactKeys(value, expected) ||
    typeof value.sourceId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.sourceId) ||
    !Array.isArray(value.packages) ||
    value.packages.length < 1 ||
    value.packages.length > 10_000
  ) {
    invalidInput()
  }
  const packages = value.packages.map((entry) => {
    const parsed = parsePackageSelection(entry)
    if (parsed.sharing !== undefined || parsed.pendingSubmissionId !== undefined) invalidInput()
    return { type: parsed.type, id: parsed.id }
  })
  if (new Set(packages.map(({ type, id }) => `${type}:${id}`)).size !== packages.length) {
    invalidInput()
  }
  const note = value.note === undefined ? undefined : submissionNote(value.note)
  return { sourceId: value.sourceId, packages, ...(note === undefined ? {} : { note }) }
}

export function adminSubmissionInput(value: unknown): {
  teamId: string
  entryId: string
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['teamId', 'entryId']) ||
    typeof value.entryId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value.entryId)
  ) {
    invalidInput()
  }
  assertTeamId(value.teamId)
  return { teamId: value.teamId, entryId: value.entryId }
}

export function backupPassphrase(value: unknown): string {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['passphrase']) ||
    typeof value.passphrase !== 'string' ||
    value.passphrase.length < 1 ||
    value.passphrase.length > 1024
  ) {
    invalidInput()
  }
  return value.passphrase
}

export function adminBackupInput(value: unknown): { teamId: string; passphrase: string } {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['teamId', 'passphrase']) ||
    typeof value.passphrase !== 'string' ||
    value.passphrase.length < 1 ||
    value.passphrase.length > 1024
  ) {
    invalidInput()
  }
  assertTeamId(value.teamId)
  return { teamId: value.teamId, passphrase: value.passphrase }
}

export function teamIdInput(value: unknown): string {
  if (!isRecord(value) || !hasExactKeys(value, ['teamId'])) invalidInput()
  assertTeamId(value.teamId)
  return value.teamId
}

export function createTeamInput(value: unknown): { name: string } {
  if (!isRecord(value) || !hasExactKeys(value, ['name'])) invalidInput()
  assertTeamName(value.name)
  return { name: value.name }
}

export function addMemberInput(value: unknown): {
  teamId: string
  displayName: string
  recipient: string
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['teamId', 'displayName', 'recipient']) ||
    typeof value.recipient !== 'string'
  ) {
    invalidInput()
  }
  assertTeamId(value.teamId)
  assertTeamName(value.displayName)
  const publicKey = parseMemberPublicKey(value.recipient)
  return {
    teamId: value.teamId,
    displayName: value.displayName,
    recipient: publicKey.combined
  }
}

export function removeMemberInput(value: unknown): { teamId: string; memberId: string } {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['teamId', 'memberId']) ||
    typeof value.memberId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.memberId)
  ) {
    invalidInput()
  }
  assertTeamId(value.teamId)
  return { teamId: value.teamId, memberId: value.memberId }
}

export function modelGrantInput(value: unknown): {
  teamId: string
  memberId: string
  models: ModelKeyGrant[]
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['teamId', 'memberId', 'models']) ||
    typeof value.memberId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.memberId) ||
    !Array.isArray(value.models) ||
    value.models.length > 64 ||
    value.models.some((model) => !isBoundaryModelGrant(model))
  ) {
    invalidInput()
  }
  assertTeamId(value.teamId)
  return {
    teamId: value.teamId,
    memberId: value.memberId,
    models: validateModelKeyGrants(value.models)
  }
}

export function publishInput(value: unknown): {
  teamId: string
  packages: TeamPackageSelection[]
  announcement?: string
  announcementOnly?: boolean
} {
  if (!isRecord(value)) invalidInput()
  const announcement = optionalAnnouncement(value)
  const announcementOnly = optionalAnnouncementOnly(value)
  assertPublishRequestShape(value, announcement, announcementOnly)
  assertTeamId(value.teamId)
  const packages = value.packages.map(parsePackageSelection)
  if (new Set(packages.map(({ type, id }) => `${type}:${id}`)).size !== packages.length) {
    invalidInput()
  }
  return {
    teamId: value.teamId,
    packages,
    ...(announcement === undefined ? {} : { announcement }),
    ...(announcementOnly === undefined ? {} : { announcementOnly })
  }
}

function assertPublishRequestShape(
  value: Record<string, unknown>,
  announcement: string | undefined,
  announcementOnly: boolean | undefined
): asserts value is Record<string, unknown> & { teamId: unknown; packages: unknown[] } {
  const expectedKeys = [
    'teamId',
    'packages',
    ...(announcement === undefined ? [] : ['announcement']),
    ...(announcementOnly === undefined ? [] : ['announcementOnly'])
  ]
  if (
    !hasExactKeys(value, expectedKeys) ||
    !Array.isArray(value.packages) ||
    (announcementOnly === true ? value.packages.length !== 0 : value.packages.length < 1) ||
    value.packages.length > 10_000
  ) {
    invalidInput()
  }
  if (announcementOnly === true && announcement === undefined) invalidInput()
}

function optionalAnnouncement(value: Record<string, unknown>): string | undefined {
  return value.announcement === undefined ? undefined : validateAnnouncementText(value.announcement)
}

function optionalAnnouncementOnly(value: Record<string, unknown>): boolean | undefined {
  if (value.announcementOnly === undefined) return undefined
  if (typeof value.announcementOnly !== 'boolean') invalidInput()
  return value.announcementOnly
}

function parsePackageSelection(selection: unknown): TeamPackageSelection {
  if (!isRecord(selection)) invalidInput()
  const selectionKeys = [
    'type',
    'id',
    ...(selection.sharing === undefined ? [] : ['sharing']),
    ...(selection.pendingSubmissionId === undefined ? [] : ['pendingSubmissionId'])
  ]
  if (
    !hasExactKeys(selection, selectionKeys) ||
    !['skill', 'plugin', 'wrapper', 'mcp'].includes(String(selection.type)) ||
    typeof selection.id !== 'string' ||
    !/^[a-z][a-z0-9-]{1,63}$/.test(selection.id) ||
    (selection.sharing !== undefined &&
      selection.sharing !== 'team-only' &&
      selection.sharing !== 'forwardable') ||
    (selection.pendingSubmissionId !== undefined &&
      (typeof selection.pendingSubmissionId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          selection.pendingSubmissionId
        )))
  ) {
    invalidInput()
  }
  return selection as unknown as TeamPackageSelection
}

function submissionNote(value: unknown): string {
  if (
    typeof value !== 'string' ||
    [...value].length > 1_000 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return (
        (codePoint >= 0x00 && codePoint <= 0x08) ||
        (codePoint >= 0x0b && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      )
    })
  ) {
    invalidInput()
  }
  return value
}

export function withdrawInput(value: unknown): { teamId: string; release: number } {
  if (!isRecord(value) || !hasExactKeys(value, ['teamId', 'release'])) invalidInput()
  assertTeamId(value.teamId)
  assertRelease(value.release)
  return { teamId: value.teamId, release: value.release }
}

function sourceLocation(value: unknown): TeamSourceInput['location'] {
  if (!isRecord(value)) invalidInput()
  if (value.kind === 'directory' && hasExactKeys(value, ['kind', 'path'])) {
    if (typeof value.path !== 'string' || value.path.length < 1 || value.path.length > 4096) {
      invalidInput()
    }
    return { kind: 'directory', path: value.path }
  }
  if (value.kind === 'https' && hasExactKeys(value, ['kind', 'url'])) {
    if (typeof value.url !== 'string' || value.url.length < 1 || value.url.length > 2048) {
      invalidInput()
    }
    return { kind: 'https', url: value.url }
  }
  return invalidInput()
}

function isBoundaryModelGrant(value: unknown): boolean {
  if (!isRecord(value)) return false
  const expected =
    value.baseUrl === undefined
      ? ['providerId', 'label', 'apiKey']
      : ['providerId', 'label', 'apiKey', 'baseUrl']
  return (
    hasExactKeys(value, expected) &&
    typeof value.providerId === 'string' &&
    value.providerId.length <= 100 &&
    typeof value.label === 'string' &&
    value.label.length <= 100 &&
    typeof value.apiKey === 'string' &&
    value.apiKey.length <= 16_384 &&
    (value.baseUrl === undefined ||
      (typeof value.baseUrl === 'string' && value.baseUrl.length <= 2048))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function invalidInput(): never {
  throw teamPackError('INVALID_FORMAT', '团队包请求格式无效')
}
