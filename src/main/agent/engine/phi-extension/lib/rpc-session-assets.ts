import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { posix } from 'node:path'
import {
  assertVerificationActive,
  verificationFailure,
  verificationRecord,
  SESSION_VERIFICATION_DEFAULT_BUDGETS,
  type SessionVerificationCapability
} from './rpc-session-verification-protocol'

function stamp(stat: Stats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.nlink,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs
  ].join(':')
}
function privateStat(stat: Stats, directory: boolean, allowLinks = false): boolean {
  return (
    (directory ? stat.isDirectory() : stat.isFile() && (allowLinks || stat.nlink === 1)) &&
    (stat.mode & 0o777) === (directory ? 0o700 : 0o600) &&
    (!process.getuid || stat.uid === process.getuid()) &&
    !stat.isSymbolicLink()
  )
}

async function boundedNames(
  directory: string,
  capability: SessionVerificationCapability
): Promise<string[]> {
  const names: string[] = []
  const handle = await opendir(directory)
  for await (const entry of handle) {
    assertVerificationActive(capability)
    if (names.length >= (capability.budgets ?? SESSION_VERIFICATION_DEFAULT_BUDGETS).references)
      verificationFailure('VERIFICATION_LIMIT')
    names.push(entry.name)
  }
  return names
}

/** SDK image sidecars are legitimate hardlinks; all links must remain in this private store. */
async function verifyBlobAliases(
  path: string,
  stat: Stats,
  names: readonly string[]
): Promise<void> {
  const basename = posix.basename(path)
  let count = 1
  for (const name of names) {
    if (!name.startsWith(basename + '.')) continue
    const alias = await lstat(posix.join(posix.dirname(path), name))
    if (alias.dev !== stat.dev || alias.ino !== stat.ino) continue
    if (
      !/^[0-9a-f]{64}\.[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(name) ||
      !privateStat(alias, false, true)
    )
      verificationFailure('FILE_INVALID')
    count++
  }
  if (count !== stat.nlink) verificationFailure('FILE_INVALID')
}
export async function verifyManagedDirectories(
  capability: SessionVerificationCapability
): Promise<void> {
  assertVerificationActive(capability)
  for (const path of [
    capability.directory,
    capability.journals,
    posix.join(capability.directory, 'data'),
    posix.join(capability.directory, 'data/omp'),
    capability.blobs
  ]) {
    try {
      if (!privateStat(await lstat(path), true) || (await realpath(path)) !== path)
        verificationFailure('FILE_INVALID')
    } catch {
      verificationFailure('FILE_INVALID')
    }
    assertVerificationActive(capability)
  }
  if ((await realpath(capability.projectRoot)) !== capability.projectRoot)
    verificationFailure('IDENTITY_MISMATCH')
}

export interface VerifiedFile {
  readonly digest: string
  readonly identity: string
  readonly size: number
}
/** Streams arbitrary asset sizes; the journal has an independent parse-work bound. */
export async function hashPrivateFile(
  path: string,
  capability: SessionVerificationCapability,
  options: {
    maxBytes?: number
    missingAsset?: boolean
    blobNames?: readonly string[]
    utf8?: boolean
  } = {}
): Promise<VerifiedFile> {
  assertVerificationActive(capability)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.missingAsset)
      verificationFailure('ASSET_MISSING')
    verificationFailure('FILE_INVALID')
  }
  try {
    const before = await handle.stat()
    if (!privateStat(before, false, options.blobNames !== undefined))
      verificationFailure('FILE_INVALID')
    if (options.blobNames) await verifyBlobAliases(path, before, options.blobNames)
    if (options.maxBytes !== undefined && before.size > options.maxBytes)
      verificationFailure('VERIFICATION_LIMIT')
    const hash = createHash('sha256')
    const decoder = options.utf8 ? new TextDecoder('utf-8', { fatal: true }) : undefined
    const buffer = Buffer.alloc(64 * 1024)
    let length = 0
    for (;;) {
      assertVerificationActive(capability)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      length += bytesRead
      if (options.maxBytes !== undefined && length > options.maxBytes)
        verificationFailure('VERIFICATION_LIMIT')
      hash.update(buffer.subarray(0, bytesRead))
      try {
        decoder?.decode(buffer.subarray(0, bytesRead), { stream: true })
      } catch {
        verificationFailure('FILE_INVALID')
      }
    }
    try {
      decoder?.decode()
    } catch {
      verificationFailure('FILE_INVALID')
    }
    assertVerificationActive(capability)
    const after = await handle.stat()
    if (options.blobNames) await verifyBlobAliases(path, after, options.blobNames)
    if (
      length !== before.size ||
      stamp(before) !== stamp(after) ||
      stamp(await lstat(path)) !== stamp(before)
    )
      verificationFailure('FILE_INVALID')
    return Object.freeze({ digest: hash.digest('hex'), identity: stamp(before), size: length })
  } finally {
    await handle.close()
  }
}

export interface SessionAssetReferences {
  readonly blobs: readonly string[]
  readonly artifacts: readonly string[]
  readonly hydration: readonly string[]
}
/** Only actual persistence carriers confer dependency authority, never free-form prose. */
export function collectSessionAssetReferences(
  entries: readonly unknown[],
  capability: SessionVerificationCapability
): SessionAssetReferences {
  const budgets = capability.budgets ?? SESSION_VERIFICATION_DEFAULT_BUDGETS
  const blobs = new Set<string>(),
    artifacts = new Set<string>()
  const hydration = new Set<string>()
  const stack: Array<{ value: unknown; key?: string }> = [{ value: entries }]
  let nodes = 0,
    references = 0
  const blob = (value: unknown, url = false): void => {
    if (typeof value !== 'string' || !value.startsWith('blob:')) return
    if (!/^blob:sha256:[0-9a-f]{64}$/u.test(value)) verificationFailure('FILE_INVALID')
    if (++references > budgets.references) verificationFailure('VERIFICATION_LIMIT')
    blobs.add(value.slice(12))
    hydration.add((url ? 'url:' : 'base64:') + value.slice(12))
  }
  const artifact = (value: unknown): void => {
    if (value === undefined) return
    if (
      typeof value !== 'string' ||
      !/^(0|[1-9][0-9]{0,15})$/u.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      verificationFailure('FILE_INVALID')
    if (++references > budgets.references) verificationFailure('VERIFICATION_LIMIT')
    artifacts.add(value)
  }
  const artifactUri = (value: unknown): void => {
    if (typeof value !== 'string' || !value.startsWith('artifact:')) return
    const match =
      /^artifact:\/\/(0|[1-9][0-9]{0,15})(?::(?:raw:)?[1-9][0-9]*(?:-[1-9][0-9]*)?)?$/u.exec(value)
    if (!match) verificationFailure('FILE_INVALID')
    artifact(match[1])
  }
  while (stack.length) {
    assertVerificationActive(capability)
    if (++nodes > budgets.nodes) verificationFailure('VERIFICATION_LIMIT')
    const { value, key } = stack.pop()!
    if (Array.isArray(value)) {
      if (nodes + stack.length + value.length > budgets.nodes)
        verificationFailure('VERIFICATION_LIMIT')
      for (const child of value) stack.push({ value: child, key })
      continue
    }
    if (!verificationRecord(value)) continue
    const image =
      typeof value.data === 'string' &&
      (value.type === 'image' ||
        (typeof value.mimeType === 'string' && value.mimeType.toLowerCase().startsWith('image/')))
    if (
      image &&
      ((key === 'content' && value.type === 'image') || key === 'images' || key === 'frames')
    )
      blob(value.data)
    if (value.type === 'image_generation_call') blob(value.result)
    blob(value.image_url, true)
    if (key === 'meta') {
      if (verificationRecord(value.truncation)) artifact(value.truncation.artifactId)
      if (verificationRecord(value.limits) && verificationRecord(value.limits.columnTruncated)) {
        artifact(value.limits.columnTruncated.artifactId)
        artifactUri(value.limits.columnTruncated.selectorBase)
      }
      if (verificationRecord(value.source) && value.source.type === 'internal')
        artifactUri(value.source.value)
    }
    for (const [childKey, child] of Object.entries(value)) {
      if (nodes + stack.length >= budgets.nodes) verificationFailure('VERIFICATION_LIMIT')
      stack.push({ value: child, key: childKey })
    }
  }
  return Object.freeze({
    blobs: Object.freeze([...blobs].sort()),
    artifacts: Object.freeze([...artifacts].sort()),
    hydration: Object.freeze([...hydration].sort())
  })
}

/** Artifacts are pinned to this journal; another registry session cannot satisfy a missing id. */
export async function verifySessionAssets(
  refs: SessionAssetReferences,
  journalPath: string,
  capability: SessionVerificationCapability
): Promise<{ readonly digest: string; readonly revision: string }> {
  const inventory = createHash('sha256')
  const revision = createHash('sha256')
  const hydration = new Set(refs.hydration)
  let decodedWork = 0
  const blobNames = refs.blobs.length ? await boundedNames(capability.blobs, capability) : []
  const aliases = new Map<string, string[]>()
  for (const name of blobNames) {
    const hash = name.slice(0, 64)
    const names = aliases.get(hash) ?? []
    names.push(name)
    aliases.set(hash, names)
  }
  for (const hash of refs.blobs) {
    const file = await hashPrivateFile(posix.join(capability.blobs, hash), capability, {
      missingAsset: true,
      blobNames: aliases.get(hash) ?? []
    })
    if (file.digest !== hash) verificationFailure('FILE_INVALID')
    // SDK.open eagerly keeps base64/URL strings, and context may hydrate lazy
    // frames. Budget the raw buffer and UTF-16 strings before either SDK step.
    if (hydration.has('base64:' + hash)) decodedWork += file.size + Math.ceil(file.size / 3) * 8
    if (hydration.has('url:' + hash)) decodedWork += file.size * 3
    if (
      !Number.isSafeInteger(decodedWork) ||
      decodedWork > (capability.budgets ?? SESSION_VERIFICATION_DEFAULT_BUDGETS).hydratedBytes
    )
      verificationFailure('VERIFICATION_LIMIT')
    inventory.update(JSON.stringify(['blob', hash, file.digest]))
    revision.update(JSON.stringify(['blob', hash, file]))
  }
  if (refs.artifacts.length) {
    const directory = journalPath.slice(0, -'.jsonl'.length)
    let files: string[]
    try {
      if (!privateStat(await lstat(directory), true) || (await realpath(directory)) !== directory)
        verificationFailure('FILE_INVALID')
      files = await boundedNames(directory, capability)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') verificationFailure('ASSET_MISSING')
      verificationFailure('FILE_INVALID')
    }
    if (files.length > (capability.budgets ?? SESSION_VERIFICATION_DEFAULT_BUDGETS).references)
      verificationFailure('VERIFICATION_LIMIT')
    const byId = new Map<string, string[]>()
    for (const name of files) {
      const id = /^([0-9]+)\./u.exec(name)?.[1]
      if (id === undefined) continue
      const matches = byId.get(id) ?? []
      matches.push(name)
      byId.set(id, matches)
    }
    for (const id of refs.artifacts) {
      const matches = byId.get(id) ?? []
      if (!matches.length) verificationFailure('ASSET_MISSING')
      if (matches.length !== 1) verificationFailure('FILE_INVALID')
      const file = await hashPrivateFile(posix.join(directory, matches[0]), capability, {
        missingAsset: true
      })
      inventory.update(JSON.stringify(['artifact', id, matches[0], file.digest]))
      revision.update(JSON.stringify(['artifact', id, matches[0], file]))
    }
  }
  assertVerificationActive(capability)
  return Object.freeze({ digest: inventory.digest('hex'), revision: revision.digest('hex') })
}
