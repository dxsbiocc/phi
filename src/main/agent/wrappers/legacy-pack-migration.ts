import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import semver from 'semver'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { assertSafePackagePath, compareText, isRecord } from '../packages/installer-utils'

const PACK_NAME = 'phi-wrappers'
const PACK_META_FILE = 'pack.json'
const PACK_INDEX_FILE = 'index.json'
const IGNORED_DIRS = new Set(['work', 'results', '.nextflow'])

export interface LegacyWrapperPackIndex {
  schemaVersion: 1
  name: string
  version: string
  digest: string
  files: Record<string, string>
}

export interface LegacyWrapperPackSelection {
  root?: string
  version?: string
  rejected: Array<{ root: string; reason: string }>
}

function hashFiles(root: string): Record<string, string> {
  const paths: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      compareText(left.name, right.name)
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(join(dir, entry.name), relative)
      } else if (
        entry.isFile() &&
        !(prefix === '' && entry.name === PACK_INDEX_FILE) &&
        entry.name !== '.DS_Store' &&
        !entry.name.startsWith('.nextflow.log')
      ) {
        assertSafePackagePath(relative)
        paths.push(relative)
      } else if (!entry.isFile()) {
        throw new Error(`legacy pack contains a non-regular entry: ${relative}`)
      }
    }
  }
  walk(root, '')
  return Object.fromEntries(
    paths.sort(compareText).map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(join(root, ...path.split('/'))))
        .digest('hex')
    ])
  )
}

function digest(files: Record<string, string>): string {
  const hash = createHash('sha256')
  for (const path of Object.keys(files).sort(compareText)) hash.update(`${path}\0${files[path]}\n`)
  return hash.digest('hex')
}

function parseIndex(root: string): LegacyWrapperPackIndex {
  const meta = JSON.parse(readFileSync(join(root, PACK_META_FILE), 'utf8')) as unknown
  const index = JSON.parse(readFileSync(join(root, PACK_INDEX_FILE), 'utf8')) as unknown
  if (
    !isRecord(meta) ||
    !isRecord(index) ||
    meta.schemaVersion !== 1 ||
    index.schemaVersion !== 1 ||
    meta.name !== PACK_NAME ||
    index.name !== PACK_NAME ||
    typeof meta.version !== 'string' ||
    index.version !== meta.version ||
    !semver.valid(meta.version) ||
    typeof index.digest !== 'string' ||
    !isRecord(index.files)
  ) {
    throw new Error('legacy pack metadata or index is invalid')
  }
  const files: Record<string, string> = {}
  for (const [path, value] of Object.entries(index.files)) {
    assertSafePackagePath(path)
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`legacy pack digest is invalid for ${path}`)
    }
    files[path] = value
  }
  const parsed = {
    schemaVersion: 1 as const,
    name: PACK_NAME,
    version: meta.version,
    digest: index.digest,
    files
  }
  if (basename(root) !== parsed.version) throw new Error('legacy pack directory/version mismatch')
  if (digest(files) !== parsed.digest) throw new Error('legacy pack index digest is invalid')
  const actual = hashFiles(root)
  const paths = [...new Set([...Object.keys(files), ...Object.keys(actual)])]
  if (paths.some((path) => actual[path] !== files[path])) {
    throw new Error('legacy pack files do not match index.json')
  }
  return parsed
}

/** Used only by migration tests and tooling that creates an old-format fixture. */
export function buildLegacyWrapperPackIndex(root: string): LegacyWrapperPackIndex {
  const meta = JSON.parse(readFileSync(join(root, PACK_META_FILE), 'utf8')) as unknown
  if (
    !isRecord(meta) ||
    meta.schemaVersion !== 1 ||
    meta.name !== PACK_NAME ||
    typeof meta.version !== 'string' ||
    !semver.valid(meta.version)
  ) {
    throw new Error('legacy pack metadata is invalid')
  }
  const files = hashFiles(root)
  return {
    schemaVersion: 1,
    name: PACK_NAME,
    version: meta.version,
    digest: digest(files),
    files
  }
}

/** Selects the newest intact overlay for one-time conversion into wrapper packages. */
export function selectLegacyWrapperPack(agentDir: string): LegacyWrapperPackSelection {
  const packsDir = join(agentDir, 'wrappers', 'packs')
  if (!existsSync(packsDir)) return { rejected: [] }
  const candidates = readdirSync(packsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && semver.valid(entry.name))
    .map((entry) => join(packsDir, entry.name))
    .sort((left, right) => semver.rcompare(basename(left), basename(right)))
  const rejected: LegacyWrapperPackSelection['rejected'] = []
  for (const root of candidates) {
    try {
      if (!lstatSync(root).isDirectory()) continue
      const index = parseIndex(root)
      return { root, version: index.version, rejected }
    } catch (error) {
      rejected.push({ root, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { rejected }
}

/**
 * Copies an intact old pack to scratch and upgrades its adapter defaults to
 * wrapper contract 1.0 without modifying the user's retained overlay.
 */
export function prepareLegacyWrapperPack(root: string, destination: string): string[] {
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(root, destination, { recursive: true, errorOnExist: true })
  const warnings: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (entry.name !== 'wrapper.yaml' || basename(dirname(path)) !== 'wrapper') continue
      const document = parseYaml(readFileSync(path, 'utf8')) as unknown
      if (!isRecord(document) || !isRecord(document.params)) continue
      const paramsPath = join(dirname(path), 'params.json')
      const defaults = JSON.parse(readFileSync(paramsPath, 'utf8')) as unknown
      if (!isRecord(defaults)) throw new Error(`${paramsPath} must contain an object`)
      let changed = false
      for (const [name, value] of Object.entries(document.params)) {
        if (!isRecord(value) || !Object.hasOwn(value, 'default')) continue
        if (!Object.hasOwn(defaults, name)) defaults[name] = value.default
        else if (!isDeepStrictEqual(defaults[name], value.default)) {
          warnings.push(`${path}: kept params.json value for conflicting default '${name}'`)
        }
        delete value.default
        changed = true
      }
      if (!changed) continue
      writeFileSync(path, stringifyYaml(document), 'utf8')
      writeFileSync(paramsPath, `${JSON.stringify(defaults, null, 2)}\n`, 'utf8')
    }
  }
  visit(destination)
  return warnings
}
