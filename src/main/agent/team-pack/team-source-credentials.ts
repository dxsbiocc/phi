import { createHash } from 'node:crypto'

import { teamPackError } from './errors'
import type { ModelKeyGrant } from './format'
import type {
  ReconciledTeamModels,
  TeamCredentialOwner,
  TeamSourceAuthStorage,
  TeamSourceServiceOptions,
  TeamSourceStoredCredential,
  TeamSourcesState
} from './team-source-types'

interface ReconcileOptions {
  state: TeamSourcesState
  teamId: string
  models: readonly ModelKeyGrant[]
  supportedProviders: TeamSourceServiceOptions['supportedProviders']
  getAuthStorage: () => Promise<TeamSourceAuthStorage>
}

export async function reconcileTeamModels(
  options: ReconcileOptions
): Promise<ReconciledTeamModels> {
  assertUniqueProviders(options.models)
  const supported = await supportedProviderPredicate(options.supportedProviders)
  const skipped = options.models
    .filter(({ providerId }) => !supported(providerId))
    .map(({ providerId }) => providerId)
  const desired = new Map(
    options.models
      .filter(({ providerId }) => supported(providerId))
      .map((model) => [model.providerId, model])
  )
  let owners = [...options.state.credentialOwners]
  const currentOwners = owners.filter((owner) => owner.teamId === options.teamId)
  if (currentOwners.length === 0 && desired.size === 0) {
    return { owners, conflicts: [], skipped }
  }
  const auth = await options.getAuthStorage()
  owners = await removeMissingTeamCredentials(auth, owners, currentOwners, desired)
  const conflicts: string[] = []
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
  const rows = options.auth.credentials.list(options.providerId)
  if (!owner) return addTeamCredential(options, rows)
  const ownedRow = rows.find((candidate) => candidate.id === owner.credentialId)
  if (!ownedRow || credentialKeySha256(ownedRow) !== owner.keySha256) {
    const remainingOwners = options.owners.filter((candidate) => candidate !== owner)
    return rows.length > 0
      ? { owners: remainingOwners, conflict: true }
      : addTeamCredential({ ...options, owners: remainingOwners }, rows)
  }
  if (rows.some((candidate) => candidate.id !== owner.credentialId)) {
    return { owners: options.owners, conflict: true }
  }
  await options.auth.credentials.set(options.providerId, {
    type: 'api_key',
    key: options.apiKey
  })
  const updated = findApiKeyRow(options.auth, options.providerId, options.apiKey)
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
  const configured = options.auth.keys?.source(options.providerId) !== undefined
  if (anotherTeamOwnsProvider || rows.length > 0 || configured) {
    return { owners: options.owners, conflict: true }
  }
  await options.auth.credentials.set(options.providerId, {
    type: 'api_key',
    key: options.apiKey
  })
  const inserted = findApiKeyRow(options.auth, options.providerId, options.apiKey)
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
): Promise<TeamCredentialOwner[]> {
  let remaining = owners
  for (const owner of currentOwners) {
    if (desired.has(owner.providerId)) continue
    await removeOwnedCredential(auth, owner)
    remaining = remaining.filter((candidate) => candidate !== owner)
  }
  return remaining
}

async function removeOwnedCredential(
  auth: TeamSourceAuthStorage,
  owner: TeamCredentialOwner
): Promise<void> {
  const row = auth.credentials
    .list(owner.providerId)
    .find((candidate) => candidate.id === owner.credentialId)
  if (row && credentialKeySha256(row) === owner.keySha256) {
    await auth.credentials.removeById(owner.providerId, owner.credentialId)
  }
}

function findApiKeyRow(
  auth: TeamSourceAuthStorage,
  providerId: string,
  apiKey: string
): TeamSourceStoredCredential {
  const digest = keySha256(apiKey)
  const row = auth.credentials
    .list(providerId)
    .find((candidate) => credentialKeySha256(candidate) === digest)
  if (!row) throw teamPackError('STORE_UNAVAILABLE', '模型凭据写入后无法确认持久化结果')
  return row
}

function credentialKeySha256(row: TeamSourceStoredCredential): string | null {
  return row.credential.type === 'api_key' && typeof row.credential.key === 'string'
    ? keySha256(row.credential.key)
    : null
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

async function supportedProviderPredicate(
  configured: TeamSourceServiceOptions['supportedProviders']
): Promise<(providerId: string) => boolean> {
  if (typeof configured === 'function') return configured
  if (configured) return (providerId) => configured.has(providerId)
  const { getCatalogProviderEntry } = await import('../engine/omp-internals')
  return (providerId) => getCatalogProviderEntry(providerId) !== undefined
}
