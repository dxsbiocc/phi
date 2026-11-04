import { createHash } from 'node:crypto'

import { teamPackError } from './errors'
import type { ModelKeyGrant } from './format'
import type {
  ReconciledTeamModels,
  TeamCredentialOwner,
  TeamSourceAuthStorage,
  TeamSourceStoredCredential,
  TeamSourcesState
} from './team-source-types'

interface ReconcileOptions {
  state: TeamSourcesState
  teamId: string
  models: readonly ModelKeyGrant[]
  getAuthStorage: () => Promise<TeamSourceAuthStorage>
}

export async function reconcileTeamModels(
  options: ReconcileOptions
): Promise<ReconciledTeamModels> {
  assertUniqueProviders(options.models)
  let owners = [...options.state.credentialOwners]
  const currentOwners = owners.filter((owner) => owner.teamId === options.teamId)
  if (currentOwners.length === 0 && options.models.length === 0) {
    return { owners, conflicts: [], skipped: [] }
  }

  const auth = await options.getAuthStorage()
  const supportedProviders = new Set(auth.getProviders().map(({ id }) => id))
  const skipped = options.models
    .filter(({ providerId }) => !supportedProviders.has(providerId))
    .map(({ providerId }) => providerId)
  const desired = new Map(
    options.models
      .filter(({ providerId }) => supportedProviders.has(providerId))
      .map((model) => [model.providerId, model])
  )
  const removed = await removeMissingTeamCredentials(auth, owners, currentOwners, desired)
  owners = removed.owners
  const conflicts = [...removed.conflicts]
  for (const [providerId, model] of desired) {
    const reconciled = await reconcileProvider({
      auth,
      owners,
      teamId: options.teamId,
      providerId,
      apiKey: model.apiKey
    })
    owners = reconciled.owners
    if (reconciled.conflict) conflicts.push(providerId)
  }
  return { owners, conflicts, skipped }
}

export async function removeTeamCredentialOwners(
  state: TeamSourcesState,
  teamId: string,
  getAuthStorage: () => Promise<TeamSourceAuthStorage>
): Promise<TeamCredentialOwner[]> {
  const owned = state.credentialOwners.filter((owner) => owner.teamId === teamId)
  if (owned.length === 0) return state.credentialOwners
  const auth = await getAuthStorage()
  for (const owner of owned) await removeOwnedCredential(auth, owner)
  // Source removal has no surviving status record on which to persist conflicts. Always drop
  // ownership metadata so the registry cannot contain an owner for a removed team.
  return state.credentialOwners.filter((owner) => owner.teamId !== teamId)
}

interface ReconcileProviderOptions {
  auth: TeamSourceAuthStorage
  owners: TeamCredentialOwner[]
  teamId: string
  providerId: string
  apiKey: string
}

async function reconcileProvider(
  options: ReconcileProviderOptions
): Promise<{ owners: TeamCredentialOwner[]; conflict: boolean }> {
  const owner = options.owners.find(
    (candidate) =>
      candidate.teamId === options.teamId && candidate.providerId === options.providerId
  )
  const rows = await providerCredentials(options.auth, options.providerId)
  if (!owner) return addTeamCredential(options, rows)

  const ownedRow = rows.find((candidate) => ownedCredentialMatches(candidate, owner))
  if (!ownedRow) {
    const remainingOwners = options.owners.filter((candidate) => candidate !== owner)
    return rows.length > 0 || options.auth.getProviderAuthStatus(options.providerId).configured
      ? { owners: remainingOwners, conflict: true }
      : addTeamCredential({ ...options, owners: remainingOwners }, rows)
  }
  if (rows.length !== 1 || hasExternalCredentialSource(options.auth, options.providerId)) {
    return { owners: options.owners, conflict: true }
  }

  await loginApiKey(options.auth, options.providerId, options.apiKey)
  const updated = await findApiKeyRow(options.auth, options.providerId, options.apiKey)
  return {
    owners: options.owners.map((candidate) =>
      candidate === owner
        ? ownerRecord(options.teamId, options.providerId, updated.id, options.apiKey)
        : candidate
    ),
    conflict: false
  }
}

async function addTeamCredential(
  options: ReconcileProviderOptions,
  rows: TeamSourceStoredCredential[]
): Promise<{ owners: TeamCredentialOwner[]; conflict: boolean }> {
  const anotherTeamOwnsProvider = options.owners.some(
    (candidate) => candidate.providerId === options.providerId
  )
  const configured = options.auth.getProviderAuthStatus(options.providerId).configured
  if (anotherTeamOwnsProvider || rows.length > 0 || configured) {
    return { owners: options.owners, conflict: true }
  }
  await loginApiKey(options.auth, options.providerId, options.apiKey)
  const inserted = await findApiKeyRow(options.auth, options.providerId, options.apiKey)
  return {
    owners: [
      ...options.owners,
      ownerRecord(options.teamId, options.providerId, inserted.id, options.apiKey)
    ],
    conflict: false
  }
}

async function removeMissingTeamCredentials(
  auth: TeamSourceAuthStorage,
  owners: TeamCredentialOwner[],
  currentOwners: TeamCredentialOwner[],
  desired: ReadonlyMap<string, ModelKeyGrant>
): Promise<{ owners: TeamCredentialOwner[]; conflicts: string[] }> {
  let remaining = owners
  const conflicts: string[] = []
  for (const owner of currentOwners) {
    if (desired.has(owner.providerId)) continue
    const result = await removeOwnedCredential(auth, owner)
    if (result === 'conflict') conflicts.push(owner.providerId)
    remaining = remaining.filter((candidate) => candidate !== owner)
  }
  return { owners: remaining, conflicts }
}

async function removeOwnedCredential(
  auth: TeamSourceAuthStorage,
  owner: TeamCredentialOwner
): Promise<'removed' | 'missing' | 'conflict'> {
  const rows = await providerCredentials(auth, owner.providerId)
  if (rows.length === 0) return 'missing'
  if (rows.length !== 1 || !ownedCredentialMatches(rows[0], owner)) return 'conflict'
  await auth.logout(owner.providerId)
  return 'removed'
}

async function loginApiKey(
  auth: TeamSourceAuthStorage,
  providerId: string,
  apiKey: string
): Promise<void> {
  await auth.login(providerId, 'api_key', {
    prompt: async () => apiKey,
    notify: () => undefined
  })
}

async function providerCredentials(
  auth: TeamSourceAuthStorage,
  providerId: string
): Promise<TeamSourceStoredCredential[]> {
  return (await auth.listCredentials()).filter((candidate) => candidate.providerId === providerId)
}

async function findApiKeyRow(
  auth: TeamSourceAuthStorage,
  providerId: string,
  apiKey: string
): Promise<{ id: number }> {
  const rows = await providerCredentials(auth, providerId)
  const digest = keySha256(apiKey)
  if (rows.length !== 1 || rows[0].type !== 'api_key' || rows[0].keySha256 !== digest) {
    throw teamPackError('STORE_UNAVAILABLE', '模型凭据写入后无法确认持久化结果')
  }
  const id = credentialId(rows[0])
  if (id === null) {
    throw teamPackError('STORE_UNAVAILABLE', '模型凭据写入后缺少稳定标识')
  }
  return { id }
}

function ownedCredentialMatches(
  row: TeamSourceStoredCredential,
  owner: TeamCredentialOwner
): boolean {
  return (
    row.id === String(owner.credentialId) &&
    row.type === 'api_key' &&
    row.keySha256 === owner.keySha256
  )
}

function hasExternalCredentialSource(auth: TeamSourceAuthStorage, providerId: string): boolean {
  const status = auth.getProviderAuthStatus(providerId)
  return status.configured && status.source !== 'stored'
}

function credentialId(row: TeamSourceStoredCredential): number | null {
  if (typeof row.id !== 'string' || !/^[1-9]\d*$/u.test(row.id)) return null
  const id = Number(row.id)
  return Number.isSafeInteger(id) ? id : null
}

function ownerRecord(
  teamId: string,
  providerId: string,
  credentialId: number,
  apiKey: string
): TeamCredentialOwner {
  return { teamId, providerId, credentialId, keySha256: keySha256(apiKey) }
}

function keySha256(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function assertUniqueProviders(models: readonly ModelKeyGrant[]): void {
  const providers = models.map(({ providerId }) => providerId)
  if (new Set(providers).size !== providers.length) {
    throw teamPackError('INVALID_FORMAT', '团队模型子 key 包含重复 provider')
  }
}
