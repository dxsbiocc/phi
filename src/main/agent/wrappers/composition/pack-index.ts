import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'

/**
 * A wrapper pack is the whole `resources/wrappers/` tree treated as one
 * versioned unit. It has to be the unit — not a single wrapper — because
 * wrapper `main.nf` files `include` modules across the tree by relative path
 * (`../../../../modules/nf-core/...`), so a wrapper is only meaningful next
 * to the exact siblings it was written against.
 *
 * - `pack.json` (committed): the pack's name and version, bumped by hand.
 * - `index.json` (generated, not committed): every file's sha256 plus a
 *   digest over all of them, written by `npm run wrappers:index`.
 *
 * The digest proves a pack is intact (nothing added, removed or edited since
 * the index was written). It does not prove who wrote it — that needs the
 * signed registry, which is deliberately out of scope here.
 */

export const PACK_META_FILE = 'pack.json'
export const PACK_INDEX_FILE = 'index.json'
const PACK_SCHEMA_VERSION = 1

/** Nextflow run leftovers and OS clutter — never part of a pack's content. */
const IGNORED_DIR_NAMES = new Set(['work', 'results', '.nextflow'])
const IGNORED_FILE_NAMES = new Set(['.DS_Store'])

export interface WrapperPackMeta {
  schemaVersion: 1
  name: string
  version: string
}

export interface WrapperPackIndex extends WrapperPackMeta {
  /** sha256 over the sorted `files` entries — see `computeWrapperPackDigest`. */
  digest: string
  /** POSIX path relative to the pack root → sha256 hex of the file's bytes. */
  files: Record<string, string>
}

export type WrapperPackVerification =
  { ok: true; index: WrapperPackIndex } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function parsePackMeta(value: unknown, source: string): WrapperPackMeta {
  if (!isRecord(value)) throw new Error(`${source} 不是 JSON 对象`)
  if (value.schemaVersion !== PACK_SCHEMA_VERSION) {
    throw new Error(`${source} 的 schemaVersion 必须是 ${PACK_SCHEMA_VERSION}`)
  }
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error(`${source} 缺少 name`)
  }
  if (typeof value.version !== 'string' || !semver.valid(value.version)) {
    throw new Error(`${source} 的 version 必须是合法的 SemVer`)
  }
  return { schemaVersion: PACK_SCHEMA_VERSION, name: value.name, version: value.version }
}

/** Reads and validates a pack root's `pack.json`; throws with a readable reason. */
export function readWrapperPackMeta(packRoot: string): WrapperPackMeta {
  const path = join(packRoot, PACK_META_FILE)
  if (!existsSync(path)) throw new Error(`缺少 ${PACK_META_FILE}`)
  return parsePackMeta(readJson(path), PACK_META_FILE)
}

/** Only the root `index.json` is the pack's own index; a nested one is ordinary content. */
function isIgnoredFile(name: string, atRoot: boolean): boolean {
  if (name === PACK_INDEX_FILE) return atRoot
  return IGNORED_FILE_NAMES.has(name) || name.startsWith('.nextflow.log')
}

/** sha256 of every pack file, keyed by POSIX relative path, in sorted order. */
export function hashWrapperPackFiles(packRoot: string): Record<string, string> {
  const relPaths: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!IGNORED_DIR_NAMES.has(entry.name)) walk(join(dir, entry.name), relPath)
      } else if (entry.isFile() && !isIgnoredFile(entry.name, prefix === '')) {
        relPaths.push(relPath)
      }
    }
  }
  walk(packRoot, '')
  relPaths.sort()

  const files: Record<string, string> = {}
  for (const relPath of relPaths) {
    files[relPath] = createHash('sha256')
      .update(readFileSync(join(packRoot, ...relPath.split('/'))))
      .digest('hex')
  }
  return files
}

export function computeWrapperPackDigest(files: Record<string, string>): string {
  const hash = createHash('sha256')
  for (const relPath of Object.keys(files).sort()) {
    hash.update(`${relPath}\0${files[relPath]}\n`)
  }
  return hash.digest('hex')
}

/** Builds the index for a pack root from its `pack.json` and current contents. */
export function buildWrapperPackIndex(packRoot: string): WrapperPackIndex {
  const meta = readWrapperPackMeta(packRoot)
  const files = hashWrapperPackFiles(packRoot)
  return { ...meta, digest: computeWrapperPackDigest(files), files }
}

function parsePackIndex(value: unknown): WrapperPackIndex {
  const meta = parsePackMeta(value, PACK_INDEX_FILE)
  const record = value as Record<string, unknown>
  if (typeof record.digest !== 'string' || !isRecord(record.files)) {
    throw new Error(`${PACK_INDEX_FILE} 缺少 digest 或 files`)
  }
  const files: Record<string, string> = {}
  for (const [relPath, sha] of Object.entries(record.files)) {
    if (typeof sha !== 'string') throw new Error(`${PACK_INDEX_FILE} 中 ${relPath} 的摘要无效`)
    files[relPath] = sha
  }
  return { ...meta, digest: record.digest, files }
}

/** Reads a pack's `index.json` without re-hashing; `undefined` when absent or unreadable. */
export function readWrapperPackIndex(packRoot: string): WrapperPackIndex | undefined {
  const path = join(packRoot, PACK_INDEX_FILE)
  if (!existsSync(path)) return undefined
  try {
    return parsePackIndex(readJson(path))
  } catch {
    return undefined
  }
}

const MAX_LISTED_PATHS = 3

function describePaths(label: string, paths: string[]): string | undefined {
  if (paths.length === 0) return undefined
  const shown = paths.slice(0, MAX_LISTED_PATHS).join('、')
  const more = paths.length > MAX_LISTED_PATHS ? ` 等 ${paths.length} 个` : ''
  return `${label}：${shown}${more}`
}

/**
 * Re-hashes a pack and checks it against its own `index.json`: same
 * name/version as `pack.json`, same file set, same bytes, same digest.
 */
export function verifyWrapperPack(packRoot: string): WrapperPackVerification {
  let meta: WrapperPackMeta
  let index: WrapperPackIndex
  try {
    meta = readWrapperPackMeta(packRoot)
    const indexPath = join(packRoot, PACK_INDEX_FILE)
    if (!existsSync(indexPath)) return { ok: false, reason: `缺少 ${PACK_INDEX_FILE}` }
    index = parsePackIndex(readJson(indexPath))
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  if (index.name !== meta.name || index.version !== meta.version) {
    return { ok: false, reason: `${PACK_INDEX_FILE} 与 ${PACK_META_FILE} 的名称或版本不一致` }
  }
  if (computeWrapperPackDigest(index.files) !== index.digest) {
    return { ok: false, reason: `${PACK_INDEX_FILE} 的 digest 与其文件列表不符` }
  }

  const actual = hashWrapperPackFiles(packRoot)
  const problems = [
    describePaths(
      '缺少文件',
      Object.keys(index.files).filter((path) => !(path in actual))
    ),
    describePaths(
      '多出文件',
      Object.keys(actual).filter((path) => !(path in index.files))
    ),
    describePaths(
      '内容被修改',
      Object.keys(index.files).filter(
        (path) => path in actual && actual[path] !== index.files[path]
      )
    )
  ].filter((problem): problem is string => problem !== undefined)

  return problems.length > 0 ? { ok: false, reason: problems.join('；') } : { ok: true, index }
}
