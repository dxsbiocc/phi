import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { Decrypter, identityToRecipient } from 'age-encryption'

import { parseTarGz, type TarEntry } from '../packages/archive'
import type { TeamResourceMap } from '../packages/installer-types'
import { readRegistry } from '../packages/registry'
import { teamPackError, isTeamPackError } from './errors'
import {
  assertManagedChildDirectory,
  assertManagedDirectory,
  extractRegistryEntries
} from './files'
import {
  parseInnerFile,
  parseGrantPlaintext,
  parseReleaseManifest,
  parseSignedLatestFile,
  parseTeamFile,
  releaseGrantPath,
  releaseManifestPath,
  releasePayloadPath,
  releaseSignaturePath,
  sha256,
  type LatestFile,
  type InnerFile,
  type ModelKeyGrant,
  type ReleaseManifest,
  type TeamAnnouncement,
  type TeamFile
} from './format'
import { assertTrustedTeamKey, verifyTeamFile } from './signing'
import { readTeamState, teamStateRoot, writeTeamState } from './state'
import type { TeamPackStore } from './store'
import { assertX25519Identity } from './validation'

const MAX_METADATA_BYTES = 64 * 1024
const MAX_PAYLOAD_BYTES = 128 * 1024 * 1024
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024
const MAX_GRANT_FILES = 256
const MAX_GRANT_BYTES = 256 * 1024

export interface PullTeamReleaseOptions {
  store: TeamPackStore
  teamKeyId: string
  identity: string
  stateDir: string
  now?: Date | (() => Date)
}

export type PullTeamReleaseResult =
  | {
      status: 'updated'
      teamId: string
      release: number
      registryDir: string
      withdrawnReleases: number[]
      models: ModelKeyGrant[]
      announcements: TeamAnnouncement[]
      resources: TeamResourceMap
    }
  | {
      status: 'up-to-date'
      teamId: string
      release: number
      registryDir: string
      withdrawnReleases: number[]
      models: ModelKeyGrant[]
      announcements: TeamAnnouncement[]
      resources: TeamResourceMap
    }

export async function pullTeamRelease(
  options: PullTeamReleaseOptions
): Promise<PullTeamReleaseResult> {
  try {
    return await pullTeamReleaseInternal(options)
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('STORE_UNAVAILABLE', '团队包拉取失败', error)
  }
}

async function pullTeamReleaseInternal(
  options: PullTeamReleaseOptions
): Promise<PullTeamReleaseResult> {
  const team = await loadTeam(options.store, options.teamKeyId)
  const latest = await loadLatest(options.store, team, options.teamKeyId)
  assertStateLocation(options.stateDir, team.teamId)
  const state = readTeamState(options.stateDir, team.teamId)
  if (state && state.teamKeyId !== options.teamKeyId) {
    throw teamPackError('UNTRUSTED_TEAM_KEY', '本地团队状态属于另一个团队公钥')
  }
  const highest = state?.highestRelease ?? null
  if (highest !== null && latest.release < highest) {
    throw teamPackError('ROLLBACK', '存储中的团队包版本低于本地已见最高版本')
  }
  if (highest === latest.release && state?.manifestSha256 !== latest.manifestSha256) {
    throw teamPackError('ROLLBACK', '同一团队包版本出现了不同的 manifest')
  }
  const manifest = await loadManifest(options.store, team, latest, options.teamKeyId)
  if (manifest.withdrawnReleases.includes(latest.release)) {
    throw teamPackError('RELEASE_WITHDRAWN', '当前团队包版本已被发布者撤回')
  }
  await assertValidIdentity(options.identity)
  const models = await loadGrants(options.store, manifest, options.identity)
  const entries = await loadArchive(options.store, manifest, options.identity)
  const inner = readReleaseInner(entries, team.teamId, latest.release)
  const registryDir = join(
    teamStateRoot(options.stateDir, team.teamId),
    String(latest.release),
    'registry'
  )
  if (highest === latest.release) {
    return {
      status: 'up-to-date',
      teamId: team.teamId,
      release: latest.release,
      registryDir,
      withdrawnReleases: manifest.withdrawnReleases,
      models,
      announcements: inner.announcements,
      resources: inner.resources
    }
  }
  commitRelease({
    stateDir: options.stateDir,
    teamId: team.teamId,
    teamKeyId: options.teamKeyId,
    release: latest.release,
    manifestSha256: latest.manifestSha256,
    entries
  })
  return {
    status: 'updated',
    teamId: team.teamId,
    release: latest.release,
    registryDir,
    withdrawnReleases: manifest.withdrawnReleases,
    models,
    announcements: inner.announcements,
    resources: inner.resources
  }
}

interface CommitReleaseOptions {
  stateDir: string
  teamId: string
  teamKeyId: string
  release: number
  manifestSha256: string
  entries: TarEntry[]
}

function commitRelease(options: CommitReleaseOptions): void {
  const { stateDir, teamId, teamKeyId, release, manifestSha256, entries } = options
  const teamRoot = teamStateRoot(stateDir, teamId)
  const target = join(teamRoot, String(release))
  assertStateLocation(stateDir, teamId)
  assertManagedDirectory(target, '本地目标发布目录')
  // State is written after the rename, so a directory without state is a crashed earlier pull.
  rmSync(target, { recursive: true, force: true })
  const stagingParent = dirname(stateDir)
  mkdirSync(stagingParent, { recursive: true })
  const temporary = join(
    stagingParent,
    `.${basename(stateDir)}.${teamId}.${release}.${process.pid}.${randomUUID()}.tmp`
  )
  mkdirSync(temporary)
  try {
    const innerBytes = extractRegistryEntries(entries, join(temporary, 'registry'))
    const inner = parseInnerFile(innerBytes)
    if (inner.teamId !== teamId || inner.release !== release) {
      throw teamPackError('INNER_MISMATCH', '解密后的 inner.json 与外层团队或版本不匹配')
    }
    try {
      readRegistry(join(temporary, 'registry'))
    } catch (error) {
      throw teamPackError('INVALID_FORMAT', '解密后的软件源校验失败', error)
    }
    mkdirSync(stateDir, { recursive: true })
    assertManagedDirectory(stateDir, '团队包状态目录')
    mkdirSync(teamRoot, { recursive: true })
    assertManagedChildDirectory(stateDir, teamRoot, '团队状态根目录')
    renameSync(temporary, target)
    try {
      writeTeamState(stateDir, teamId, teamKeyId, release, manifestSha256)
    } catch (error) {
      rmSync(target, { recursive: true, force: true })
      throw error
    }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    if (isTeamPackError(error)) throw error
    throw teamPackError('STORE_UNAVAILABLE', '无法提交团队包到本地状态目录', error)
  }
}

function assertStateLocation(stateDir: string, teamId: string): void {
  assertManagedDirectory(stateDir, '团队包状态目录')
  assertManagedChildDirectory(stateDir, teamStateRoot(stateDir, teamId), '团队状态根目录')
}

function readReleaseInner(entries: TarEntry[], teamId: string, release: number): InnerFile {
  const matching = entries.filter((entry) => entry.path === 'inner.json')
  if (matching.length !== 1 || matching[0]?.type !== 'file') {
    throw teamPackError('INVALID_FORMAT', '团队包归档必须包含一个普通 inner.json 文件')
  }
  const inner = parseInnerFile(matching[0].data)
  if (inner.teamId !== teamId || inner.release !== release) {
    throw teamPackError('INNER_MISMATCH', '解密后的 inner.json 与外层团队或版本不匹配')
  }
  return inner
}

async function loadTeam(store: TeamPackStore, keyId: string): Promise<TeamFile> {
  const team = parseTeamFile(await readRequired(store, 'team.json', MAX_METADATA_BYTES))
  assertTrustedTeamKey(team.publicKey, keyId)
  return team
}

async function loadLatest(
  store: TeamPackStore,
  team: TeamFile,
  keyId: string
): Promise<LatestFile> {
  const data = await readRequired(store, 'latest.json', MAX_METADATA_BYTES)
  const signedLatest = parseSignedLatestFile(data)
  verifyTeamFile(signedLatest.pointerBytes, signedLatest.signatureBytes, team.publicKey, keyId)
  const latest = signedLatest.pointer
  if (latest.teamId !== team.teamId) {
    throw teamPackError('INVALID_FORMAT', 'latest.json 的团队标识不匹配')
  }
  return latest
}

async function loadGrants(
  store: TeamPackStore,
  manifest: ReleaseManifest,
  identity: string
): Promise<ModelKeyGrant[]> {
  if (manifest.grants.length > MAX_GRANT_FILES) {
    throw teamPackError('INVALID_FORMAT', '模型子 key grant 数量超过限制')
  }
  const encrypted = await Promise.all(
    manifest.grants.map(async (file) => {
      const data = await readRequired(
        store,
        releaseGrantPath(manifest.release, file.name),
        Math.min(file.bytes, MAX_GRANT_BYTES)
      )
      if (data.length !== file.bytes || sha256(data) !== file.sha256) {
        throw teamPackError('HASH_MISMATCH', `模型子 key grant ${file.name} 大小或哈希不匹配`)
      }
      return data
    })
  )

  let matched: ModelKeyGrant[] | undefined
  for (const data of encrypted) {
    const plaintext = await tryDecryptGrant(data, identity)
    if (!plaintext) continue
    const grant = parseGrantPlaintext(plaintext)
    if (grant.teamId !== manifest.teamId || grant.release !== manifest.release) {
      throw teamPackError('INNER_MISMATCH', '解密后的模型子 key grant 与团队或版本不匹配')
    }
    if (matched) {
      throw teamPackError('INVALID_FORMAT', '成员匹配到多个模型子 key grant')
    }
    matched = grant.models
  }
  return matched ?? []
}

async function loadManifest(
  store: TeamPackStore,
  team: TeamFile,
  latest: LatestFile,
  keyId: string
): Promise<ReleaseManifest> {
  const [data, signature] = await Promise.all([
    readRequired(store, releaseManifestPath(latest.release), MAX_METADATA_BYTES),
    readRequired(store, releaseSignaturePath(latest.release), MAX_METADATA_BYTES)
  ])
  if (sha256(data) !== latest.manifestSha256) {
    throw teamPackError('HASH_MISMATCH', 'manifest.json 哈希与 latest.json 不匹配')
  }
  verifyTeamFile(data, signature, team.publicKey, keyId)
  const manifest = parseReleaseManifest(data, MAX_PAYLOAD_BYTES)
  if (manifest.teamId !== team.teamId || manifest.release !== latest.release) {
    throw teamPackError('INVALID_FORMAT', 'manifest.json 与 latest.json 不匹配')
  }
  return manifest
}

async function loadArchive(
  store: TeamPackStore,
  manifest: ReleaseManifest,
  identity: string
): Promise<TarEntry[]> {
  const payload = await readRequired(
    store,
    releasePayloadPath(manifest.release),
    manifest.payloadBytes
  )
  if (payload.length !== manifest.payloadBytes || sha256(payload) !== manifest.payloadSha256) {
    throw teamPackError('HASH_MISMATCH', 'payload.age 大小或哈希不匹配')
  }
  return parseArchive(await decryptPayload(payload, identity))
}

async function readRequired(store: TeamPackStore, path: string, maxBytes: number): Promise<Buffer> {
  let value: Buffer | null
  try {
    value = await store.read(path, maxBytes)
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('STORE_UNAVAILABLE', '无法读取团队包存储', error)
  }
  if (value === null) throw teamPackError('STORE_UNAVAILABLE', `团队包存储缺少 ${path}`)
  return value
}

async function decryptPayload(payload: Buffer, identity: string): Promise<Buffer> {
  await assertValidIdentity(identity)
  try {
    const decrypter = new Decrypter()
    decrypter.addIdentity(identity)
    return Buffer.from(await decrypter.decrypt(payload))
  } catch {
    throw teamPackError('NOT_A_MEMBER', '无法解密：你不在这个版本的接收方中')
  }
}

async function assertValidIdentity(identity: string): Promise<void> {
  assertX25519Identity(identity)
  try {
    await identityToRecipient(identity)
  } catch {
    throw teamPackError('INVALID_FORMAT', '成员 age X25519 私钥格式无效')
  }
}

async function tryDecryptGrant(payload: Buffer, identity: string): Promise<Buffer | null> {
  try {
    const decrypter = new Decrypter()
    decrypter.addIdentity(identity)
    return Buffer.from(await decrypter.decrypt(payload))
  } catch {
    return null
  }
}

function parseArchive(archive: Buffer): ReturnType<typeof parseTarGz> {
  try {
    return parseTarGz(archive, MAX_EXPANDED_BYTES)
  } catch (error) {
    throw teamPackError('INVALID_FORMAT', '解密后的团队包归档无效', error)
  }
}
