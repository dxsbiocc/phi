import { isAbsolute } from 'node:path'
import { satisfies, valid, validRange } from 'semver'

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const PACKAGE_PATH =
  /^(?:node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/
const BIN_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/
const LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare'
])
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
export type JsonObject = Record<string, unknown>

export interface LockedPackage {
  location: string
  name: string
  version: string
  url: string
  integrity: string
  entry: JsonObject
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Bun application: ${label} must be an object`)
  }
  return value as JsonObject
}

export function parseJsonObject(bytes: Buffer, label: string): JsonObject {
  try {
    return object(JSON.parse(bytes.toString('utf8')), label)
  } catch (error) {
    throw new Error(`Bun application: invalid ${label}: ${String(error)}`)
  }
}

export function validatePackageManifest(manifest: JsonObject, label: string): void {
  if (manifest.gypfile === true || manifest.hasInstallScript === true) {
    throw new Error(
      `Bun application: ${label} requires unsupported lifecycle scripts/native builds`
    )
  }
  if (manifest.scripts !== undefined) {
    const scripts = object(manifest.scripts, `${label} scripts`)
    if (Object.keys(scripts).some((name) => LIFECYCLE_SCRIPTS.has(name))) {
      throw new Error(
        `Bun application: ${label} requires unsupported lifecycle scripts/native builds`
      )
    }
  }
  for (const field of [
    'workspaces',
    'overrides',
    'resolutions',
    'patchedDependencies',
    'trustedDependencies',
    'bundleDependencies',
    'bundledDependencies'
  ]) {
    if (manifest[field] !== undefined && manifest[field] !== false) {
      throw new Error(`Bun application: ${label} uses unsupported ${field}`)
    }
  }
  if (manifest.bin !== undefined) {
    const bins =
      typeof manifest.bin === 'string'
        ? { bin: manifest.bin }
        : object(manifest.bin, `${label} bin`)
    for (const [name, target] of Object.entries(bins)) {
      if (!BIN_NAME.test(name) || typeof target !== 'string' || !safePackageFile(target)) {
        throw new Error(`Bun application: ${label} has an unsafe executable path`)
      }
    }
  }
}

function safePackageFile(path: string): boolean {
  const normalized = path.startsWith('./') ? path.slice(2) : path
  return (
    normalized.length > 0 &&
    !isAbsolute(normalized) &&
    !normalized.includes('\\') &&
    !normalized.includes('\0') &&
    normalized.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

function dependencies(entry: JsonObject, field: string, label: string): Record<string, string> {
  if (entry[field] === undefined) return {}
  const values = object(entry[field], `${label} ${field}`)
  const result: Record<string, string> = {}
  for (const [name, version] of Object.entries(values)) {
    if (!PACKAGE_NAME.test(name) || typeof version !== 'string' || !validRange(version)) {
      throw new Error(
        `Bun application: ${label} dependency ${name} is not a registry version range`
      )
    }
    result[name] = version
  }
  return result
}

function lockedUrl(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new Error(`Bun application: ${label} has no pinned tarball URL`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Bun application: ${label} has an invalid tarball URL`)
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    /(?:^|\.)(?:github(?:usercontent)?\.com|gitlab\.com|bitbucket\.org)$/i.test(url.hostname) ||
    /\/(?:refs\/heads|branches)(?:\/|$)|\/(?:-\/)?archive\/(?:main|master|HEAD)(?:[/.]|$)/i.test(
      url.pathname
    ) ||
    !/\.(?:tgz|tar\.gz)$/.test(url.pathname)
  ) {
    throw new Error(`Bun application: ${label} requires a pinned HTTPS registry tarball`)
  }
  return url.href
}

function npmLockedPackages(manifest: JsonObject, lock: JsonObject): LockedPackage[] {
  validatePackageManifest(manifest, 'manifest')
  if (lock.lockfileVersion !== 3)
    throw new Error('Bun application: package-lock.json must use lockfileVersion 3')
  const entries = object(lock.packages, 'lock packages')
  const root = object(entries[''], 'lock root')
  if (
    typeof manifest.name !== 'string' ||
    !PACKAGE_NAME.test(manifest.name) ||
    typeof manifest.version !== 'string' ||
    !EXACT_VERSION.test(manifest.version) ||
    !valid(manifest.version)
  ) {
    throw new Error('Bun application: manifest requires a package name and exact version')
  }
  if (
    root.name !== manifest.name ||
    root.version !== manifest.version ||
    lock.name !== manifest.name ||
    lock.version !== manifest.version
  ) {
    throw new Error('Bun application: lock root does not match the manifest')
  }
  for (const field of DEPENDENCY_FIELDS) {
    const declared = dependencies(manifest, field, 'manifest')
    const locked = dependencies(root, field, 'lock root')
    if (
      Object.entries(declared).some(
        ([, version]) => !EXACT_VERSION.test(version) || !valid(version)
      )
    ) {
      throw new Error(`Bun application: manifest ${field} must use exact versions`)
    }
    if (
      JSON.stringify(Object.entries(declared).sort()) !==
      JSON.stringify(Object.entries(locked).sort())
    ) {
      throw new Error(`Bun application: lock root ${field} does not match the manifest`)
    }
  }
  const result: LockedPackage[] = []
  for (const [location, value] of Object.entries(entries)) {
    if (location === '') continue
    if (!PACKAGE_PATH.test(location))
      throw new Error(`Bun application: unsafe lock package path ${location}`)
    const entry = object(value, location)
    validatePackageManifest(entry, location)
    if (entry.link || entry.inBundle)
      throw new Error(`Bun application: ${location} uses unsupported linked/bundled packages`)
    if (
      typeof entry.version !== 'string' ||
      !EXACT_VERSION.test(entry.version) ||
      !valid(entry.version)
    ) {
      throw new Error(`Bun application: ${location} requires an exact version`)
    }
    if (
      typeof entry.integrity !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)
    ) {
      throw new Error(`Bun application: ${location} requires sha512 integrity`)
    }
    const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)
    if (entry.name !== undefined && entry.name !== name)
      throw new Error(`Bun application: ${location} uses an unsupported package alias`)
    result.push({
      location,
      name,
      version: entry.version,
      url: lockedUrl(entry.resolved, location),
      integrity: entry.integrity,
      entry
    })
  }
  verifyDependencyTree(entries)
  return result
}

function dependencyEntry(
  entries: JsonObject,
  location: string,
  name: string
): JsonObject | undefined {
  let parent = location
  while (true) {
    const candidate = entries[`${parent ? `${parent}/` : ''}node_modules/${name}`]
    if (candidate !== undefined) return object(candidate, name)
    if (!parent) return undefined
    parent = parent.replace(/\/?node_modules\/(?:@[^/]+\/)?[^/]+$/, '')
  }
}

function verifyDependencyTree(entries: JsonObject): void {
  for (const [location, value] of Object.entries(entries)) {
    const entry = object(value, location || 'lock root')
    const optional = dependencies(entry, 'optionalDependencies', location)
    const peers = dependencies(entry, 'peerDependencies', location)
    const peerMeta =
      entry.peerDependenciesMeta === undefined
        ? {}
        : object(entry.peerDependenciesMeta, `${location} peer metadata`)
    const declared = { ...dependencies(entry, 'dependencies', location), ...optional, ...peers }
    if (!location) Object.assign(declared, dependencies(entry, 'devDependencies', 'lock root'))
    for (const [name, range] of Object.entries(declared)) {
      const installed = dependencyEntry(entries, location, name)
      const optionalPeer =
        Object.hasOwn(peerMeta, name) &&
        object(peerMeta[name], `${name} peer metadata`).optional === true
      if (!installed && (Object.hasOwn(optional, name) || optionalPeer)) continue
      if (
        !installed ||
        typeof installed.version !== 'string' ||
        !satisfies(installed.version, range)
      ) {
        throw new Error(
          `Bun application: incomplete or inconsistent lock dependency ${location || '(root)'} -> ${name}`
        )
      }
    }
  }
}

function jsonc(bytes: Buffer): JsonObject {
  const input = bytes.toString('utf8')
  let stripped = ''
  let quoted = false
  let escaped = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (quoted) {
      stripped += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') {
      quoted = true
      stripped += char
    } else if (char === '/' && input[index + 1] === '/') {
      while (index < input.length && input[index] !== '\n') index++
      stripped += '\n'
    } else if (char === '/' && input[index + 1] === '*') {
      const end = input.indexOf('*/', index + 2)
      if (end === -1) throw new Error('Bun application: unterminated bun.lock comment')
      index = end + 1
      stripped += ' '
    } else stripped += char
  }
  let normalized = ''
  quoted = false
  escaped = false
  for (let index = 0; index < stripped.length; index++) {
    const char = stripped[index]
    if (!quoted && char === ',' && /^\s*[}\]]/.test(stripped.slice(index + 1))) continue
    normalized += char
    if (quoted && escaped) escaped = false
    else if (quoted && char === '\\') escaped = true
    else if (char === '"') quoted = !quoted
  }
  return parseJsonObject(Buffer.from(normalized), 'bun.lock')
}

function bunPackageLocation(key: string): string {
  const parts = key.split('/')
  const names: string[] = []
  for (let index = 0; index < parts.length; index++) {
    const name = parts[index].startsWith('@') ? `${parts[index]}/${parts[++index]}` : parts[index]
    if (!PACKAGE_NAME.test(name))
      throw new Error(`Bun application: unsafe lock package path ${key}`)
    names.push(name)
  }
  return names.map((name) => `node_modules/${name}`).join('/')
}

function normalizeBunLock(manifest: JsonObject, lock: JsonObject): JsonObject {
  if (
    lock.lockfileVersion !== 1 ||
    (lock.configVersion !== undefined && ![0, 1].includes(Number(lock.configVersion)))
  ) {
    throw new Error('Bun application: unsupported bun.lock version')
  }
  for (const field of [
    'overrides',
    'resolutions',
    'patchedDependencies',
    'trustedDependencies',
    'catalog',
    'catalogs'
  ]) {
    if (lock[field] !== undefined)
      throw new Error(`Bun application: bun.lock uses unsupported ${field}`)
  }
  const workspaces = object(lock.workspaces, 'bun.lock workspaces')
  if (Object.keys(workspaces).length !== 1 || !Object.hasOwn(workspaces, '')) {
    throw new Error('Bun application: only a single packaged root workspace is supported')
  }
  const root = object(workspaces[''], 'bun.lock root')
  if (
    root.name !== manifest.name ||
    (root.version !== undefined && root.version !== manifest.version)
  ) {
    throw new Error('Bun application: bun.lock root does not match the manifest')
  }
  const entries: JsonObject = { '': { ...root, version: manifest.version } }
  for (const [key, value] of Object.entries(object(lock.packages, 'bun.lock packages'))) {
    const location = bunPackageLocation(key)
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      typeof value[0] !== 'string' ||
      typeof value[1] !== 'string'
    ) {
      throw new Error(`Bun application: ${key} must be a registry package with pinned integrity`)
    }
    const separator = value[0].lastIndexOf('@')
    const name = value[0].slice(0, separator)
    const version = value[0].slice(separator + 1)
    const expected = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)
    if (
      name !== expected ||
      !PACKAGE_NAME.test(name) ||
      !EXACT_VERSION.test(version) ||
      !valid(version)
    ) {
      throw new Error(`Bun application: ${key} requires a matching package name and exact version`)
    }
    const metadata = object(value[2], `${key} metadata`)
    if (metadata.bundled || metadata.binDir)
      throw new Error(`Bun application: ${key} uses unsupported bundled packages/binDir`)
    const optionalPeers = metadata.optionalPeers ?? []
    if (
      !Array.isArray(optionalPeers) ||
      !optionalPeers.every((peer) => typeof peer === 'string' && PACKAGE_NAME.test(peer))
    ) {
      throw new Error(`Bun application: ${key} has invalid optional peers`)
    }
    entries[location] = {
      ...metadata,
      version,
      resolved:
        value[1] || `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
      integrity: value[3],
      peerDependenciesMeta: Object.fromEntries(
        optionalPeers.map((peer) => [peer, { optional: true }])
      )
    }
  }
  return { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: entries }
}

/** Both formats describe the same complete registry-only dependency tree; no resolution is performed. */
export function parseJavaScriptLock(
  manifest: JsonObject,
  bytes: Buffer,
  file: './bun.lock' | './package-lock.json'
): LockedPackage[] {
  const lock =
    file === './bun.lock'
      ? normalizeBunLock(manifest, jsonc(bytes))
      : parseJsonObject(bytes, 'package-lock.json')
  const packages = npmLockedPackages(manifest, lock)
  if (packages.length > 10000)
    throw new Error('Bun application: lock package count exceeds its bound')
  const entries = object(lock.packages, 'lock packages')
  const locations = new Map(Object.entries(entries).map(([path, entry]) => [entry, path]))
  const runtime = new Set<string>()
  const required = new Set<string>()
  const visited = new Set<string>()
  const queue = [{ location: '', optional: false }]
  while (queue.length) {
    const current = queue.pop()!
    const key = `${current.location}:${current.optional}`
    if (visited.has(key)) continue
    visited.add(key)
    const entry = object(entries[current.location], current.location)
    const optional = dependencies(entry, 'optionalDependencies', current.location)
    const declared = {
      ...dependencies(entry, 'dependencies', current.location),
      ...optional,
      ...dependencies(entry, 'peerDependencies', current.location)
    }
    const peers =
      entry.peerDependenciesMeta === undefined
        ? {}
        : object(entry.peerDependenciesMeta, 'peer metadata')
    for (const name of Object.keys(declared)) {
      const target = dependencyEntry(entries, current.location, name)
      if (!target) continue
      const location = locations.get(target)!
      const optionalPeer =
        Object.hasOwn(peers, name) && object(peers[name], 'peer metadata').optional === true
      const isOptional = current.optional || Object.hasOwn(optional, name) || Boolean(optionalPeer)
      runtime.add(location)
      if (!isOptional) required.add(location)
      queue.push({ location, optional: isOptional })
    }
  }
  for (const pkg of packages) {
    pkg.entry.dev = !runtime.has(pkg.location)
    pkg.entry.optional = runtime.has(pkg.location) && !required.has(pkg.location)
  }
  return packages
}

export function assertPackageDependencies(manifest: JsonObject, pkg: LockedPackage): void {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const actual = dependencies(manifest, field, pkg.name)
    const expected = dependencies(pkg.entry, field, pkg.location)
    if (
      JSON.stringify(Object.entries(actual).sort()) !==
      JSON.stringify(Object.entries(expected).sort())
    ) {
      throw new Error(`Bun application: ${pkg.name} tarball ${field} do not match its lock`)
    }
  }
}
