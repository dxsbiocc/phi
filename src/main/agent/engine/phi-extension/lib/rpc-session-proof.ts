import { lstat, realpath } from 'node:fs/promises'
import { posix } from 'node:path'
import type { ExtensionAPI, SessionManager } from '@oh-my-pi/pi-coding-agent'
import {
  collectSessionAssetReferences,
  hashPrivateFile,
  verifyManagedDirectories,
  verifySessionAssets
} from './rpc-session-assets'
import {
  assertVerificationActive,
  verificationFailure,
  verificationRecord,
  verificationText,
  SESSION_VERIFICATION_DEFAULT_BUDGETS,
  type SessionVerificationCapability,
  type SessionVerificationProof,
  type SessionVerificationRequest
} from './rpc-session-verification-protocol'

type SessionSdk = Pick<
  ExtensionAPI['pi'],
  'loadSessionFile' | 'SessionManager' | 'getRestorableSessionModels'
>

/** Pinned SDK native Anthropic summary carrier; opaque content is never parsed. */
function validNativeAnthropicCompaction(preserveData: unknown, consumeWork: () => void): boolean {
  if (!verificationRecord(preserveData) || !Object.hasOwn(preserveData, 'anthropicCompaction'))
    return false
  const value = preserveData.anthropicCompaction
  if (!verificationRecord(value)) verificationFailure('FILE_INVALID')
  const keys = [
    'provider',
    'content',
    'signature',
    'encryptedContent',
    'filesText',
    'retainedFiles',
    'exactTail',
    'model',
    'usedTokens'
  ]
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    !verificationText(value.provider, 1024) ||
    typeof value.content !== 'string' ||
    value.content.length === 0
  )
    verificationFailure('FILE_INVALID')
  for (const key of ['signature', 'encryptedContent', 'filesText', 'model']) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' || (value[key] as string).length === 0)
    )
      verificationFailure('FILE_INVALID')
  }
  if (
    (value.exactTail !== undefined && value.exactTail !== true) ||
    (value.usedTokens !== undefined &&
      (typeof value.usedTokens !== 'number' ||
        !Number.isFinite(value.usedTokens) ||
        value.usedTokens < 0))
  )
    verificationFailure('FILE_INVALID')
  if (value.retainedFiles !== undefined) {
    if (!Array.isArray(value.retainedFiles)) verificationFailure('FILE_INVALID')
    for (const file of value.retainedFiles) {
      consumeWork()
      if (
        !verificationRecord(file) ||
        Object.keys(file).sort().join(',') !== 'after,text' ||
        typeof file.text !== 'string' ||
        typeof file.after !== 'number' ||
        !Number.isFinite(file.after)
      )
        verificationFailure('FILE_INVALID')
    }
  }
  return true
}

/** SDK parsing is intentionally lenient; reject structural loss before opening a manager. */
export function verifySessionGraph(
  entries: readonly unknown[],
  capability: SessionVerificationCapability
): string | null {
  const budgets = capability.budgets ?? SESSION_VERIFICATION_DEFAULT_BUDGETS
  if (!entries.length || entries.length > budgets.entries)
    verificationFailure(entries.length ? 'VERIFICATION_LIMIT' : 'FILE_INVALID')
  const byId = new Map<string, Record<string, unknown>>()
  let work = 0
  for (let index = 0; index < entries.length; index++) {
    assertVerificationActive(capability)
    if (++work > budgets.nodes) verificationFailure('VERIFICATION_LIMIT')
    const entry = entries[index]
    if (!verificationRecord(entry)) verificationFailure('FILE_INVALID')
    if (!index) {
      if (entry.type !== 'session') verificationFailure('FILE_INVALID')
      continue
    }
    if (
      !verificationText(entry.type, 128) ||
      entry.type === 'session' ||
      !verificationText(entry.id) ||
      byId.has(entry.id) ||
      !(entry.parentId === null || (typeof entry.parentId === 'string' && byId.has(entry.parentId)))
    )
      verificationFailure('FILE_INVALID')
    if (entry.type === 'compaction') {
      const native = validNativeAnthropicCompaction(entry.preserveData, () => {
        if (++work > budgets.nodes) verificationFailure('VERIFICATION_LIMIT')
      })
      if (!(native && entry.firstKeptEntryId === '')) {
        if (!verificationText(entry.firstKeptEntryId)) verificationFailure('FILE_INVALID')
        let parent = entry.parentId
        while (parent !== null && parent !== entry.firstKeptEntryId) {
          if (++work > budgets.nodes) verificationFailure('VERIFICATION_LIMIT')
          parent = byId.get(parent as string)!.parentId as string | null
        }
        if (parent === null) verificationFailure('FILE_INVALID')
      }
      if (entry.providerReplayThroughEntryId !== undefined) {
        let replay = entry.parentId
        while (replay !== null && replay !== entry.providerReplayThroughEntryId) {
          if (++work > budgets.nodes) verificationFailure('VERIFICATION_LIMIT')
          replay = byId.get(replay as string)!.parentId as string | null
        }
        if (replay === null) verificationFailure('FILE_INVALID')
      }
    }
    byId.set(entry.id, entry)
  }
  return entries.length > 1 ? (entries[entries.length - 1] as { id: string }).id : null
}

/** The pinned SDK uses this exact macOS alias, after confirming real directory identity. */
async function verifyProjectCwd(
  cwd: unknown,
  capability: SessionVerificationCapability,
  expectedIdentity?: string
): Promise<string> {
  assertVerificationActive(capability)
  if (
    cwd !== capability.projectRoot &&
    !(
      process.platform === 'darwin' &&
      capability.projectRoot.startsWith('/private/') &&
      cwd === capability.projectRoot.slice('/private'.length)
    )
  )
    verificationFailure('IDENTITY_MISMATCH')
  let identity: string
  try {
    const stat = await lstat(cwd as string)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(cwd as string)) !== capability.projectRoot
    )
      verificationFailure('IDENTITY_MISMATCH')
    identity = `${stat.dev}:${stat.ino}`
  } catch {
    assertVerificationActive(capability)
    verificationFailure('IDENTITY_MISMATCH')
  }
  assertVerificationActive(capability)
  if (expectedIdentity !== undefined && identity !== expectedIdentity)
    verificationFailure('IDENTITY_MISMATCH')
  return identity
}

async function verifyManager(
  manager: SessionManager,
  path: string,
  request: SessionVerificationRequest,
  capability: SessionVerificationCapability,
  leaf: string | null,
  projectIdentity: string
): Promise<void> {
  assertVerificationActive(capability)
  const header = manager.getHeader()
  if (
    manager.loadedMalformedRecords !== 0 ||
    manager.getSessionFile() !== path ||
    manager.getSessionId() !== request.ompSessionId ||
    header?.id !== request.ompSessionId ||
    header.version !== 3 ||
    manager.getLeafId() !== leaf
  )
    verificationFailure('IDENTITY_MISMATCH')
  for (const cwd of [header.cwd, manager.getRecordedCwd(), manager.getCwd()])
    await verifyProjectCwd(cwd, capability, projectIdentity)
  let previous: string | null = null
  for (const entry of manager.getBranch()) {
    if (entry.parentId !== previous) verificationFailure('FILE_INVALID')
    previous = entry.id
  }
  if (previous !== leaf) verificationFailure('FILE_INVALID')
}

/** Repeated raw/asset digests bound SDK path-only reads; they do not promise fd adoption or fsync. */
export async function proveSavedSession(
  sdk: SessionSdk,
  capability: SessionVerificationCapability,
  request: SessionVerificationRequest,
  liveManager?: SessionManager
): Promise<SessionVerificationProof> {
  const path = posix.join(capability.journals, request.journalBasename)
  const budgets = capability.budgets ?? SESSION_VERIFICATION_DEFAULT_BUDGETS
  await verifyManagedDirectories(capability)
  const projectIdentity = await verifyProjectCwd(capability.projectRoot, capability)
  const before = await hashPrivateFile(path, capability, {
    maxBytes: budgets.journalBytes,
    utf8: true
  })
  if (!before.size) verificationFailure('FILE_INVALID')
  const loaded = await sdk.loadSessionFile(path, undefined, { throwIfMissing: true })
  assertVerificationActive(capability)
  if (loaded.invalidHeader || loaded.malformedRecords || loaded.sourceSize !== before.size)
    verificationFailure('FILE_INVALID')
  const leaf = verifySessionGraph(loaded.entries, capability)
  const header = loaded.entries[0]
  if (header.type !== 'session' || header.version !== 3 || header.id !== request.ompSessionId)
    verificationFailure('IDENTITY_MISMATCH')
  await verifyProjectCwd(header.cwd, capability, projectIdentity)
  const refs = collectSessionAssetReferences(loaded.entries, capability)
  const assets = await verifySessionAssets(refs, path, capability)
  let inspected: SessionManager | undefined
  let model: SessionVerificationProof['model'] = null
  let modelRole: SessionVerificationProof['modelRole'] = null
  try {
    inspected = await sdk.SessionManager.open(path, capability.journals, undefined, {
      throwIfMissing: true,
      suppressBreadcrumb: true,
      initialCwd: capability.projectRoot
    })
    await verifyManager(inspected, path, request, capability, leaf, projectIdentity)
    if (liveManager)
      await verifyManager(liveManager, path, request, capability, leaf, projectIdentity)
    const context = inspected.buildSessionContext({ maxFrameDataBytes: 0 })
    const lastModelChangeRole = inspected.getLastModelChangeRole()
    const candidates = sdk.getRestorableSessionModels(
      // Models do not require materializing snapcompact frames. Assets have
      // already been verified independently; this does not change live context.
      context.models,
      lastModelChangeRole
    )
    if (candidates.length) {
      const value = candidates[0],
        separator = value.indexOf('/')
      if (separator < 1 || separator === value.length - 1 || !verificationText(value, 1024))
        verificationFailure('FILE_INVALID')
      model = Object.freeze({ provider: value.slice(0, separator), id: value.slice(separator + 1) })
      modelRole =
        lastModelChangeRole &&
        lastModelChangeRole !== 'fallback' &&
        context.models[lastModelChangeRole] === value
          ? lastModelChangeRole
          : 'default'
    }
  } finally {
    await inspected?.close()
  }
  assertVerificationActive(capability)
  const afterAssets = await verifySessionAssets(refs, path, capability)
  const after = await hashPrivateFile(path, capability, {
    maxBytes: budgets.journalBytes,
    utf8: true
  })
  if (
    before.identity !== after.identity ||
    before.digest !== after.digest ||
    assets.digest !== afterAssets.digest ||
    assets.revision !== afterAssets.revision
  )
    verificationFailure('FILE_INVALID')
  await verifyManagedDirectories(capability)
  await verifyProjectCwd(capability.projectRoot, capability, projectIdentity)
  return Object.freeze({
    ompSessionId: request.ompSessionId,
    phiSessionId: capability.phiSessionId,
    generation: capability.generation,
    projectRoot: capability.projectRoot,
    journalPath: path,
    leafId: leaf,
    model,
    modelRole,
    journalDigest: before.digest,
    assetDigest: assets.digest,
    entryCount: loaded.entries.length - 1,
    blobCount: refs.blobs.length,
    artifactCount: refs.artifacts.length
  })
}
