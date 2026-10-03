import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import semver from 'semver'

import type { LocalRegistry, RegistryPackageEntry } from './installer-types'
import type { PackageDependency, PackageRequirements } from './manifest'
import { errorMessage, isRecord, packageVersionKey } from './installer-utils'
import { parseRegistrySignature, verifyRegistryIndex, type TrustedRegistryKey } from './signature'
import { TRUSTED_REGISTRY_KEYS } from './trusted-keys'

export interface ReadRegistryOptions {
  builtin?: boolean
  trustedKeys?: readonly TrustedRegistryKey[]
}

export function readRegistry(dir: string, options: ReadRegistryOptions = {}): LocalRegistry {
  const registryDir = resolve(dir)
  let indexBytes: Buffer
  let value: unknown
  try {
    indexBytes = readFileSync(join(registryDir, 'index.json'))
    value = JSON.parse(indexBytes.toString('utf8')) as unknown
  } catch (error) {
    throw new Error(`无法读取本地软件包注册表: ${errorMessage(error)}`)
  }
  const trust = options.builtin
    ? 'builtin'
    : readRegistryTrust(registryDir, indexBytes, options.trustedKeys ?? TRUSTED_REGISTRY_KEYS)
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.packages)) {
    throw new Error('本地软件包注册表 index.json 格式无效')
  }
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) {
    throw new Error('本地软件包注册表 generatedAt 无效')
  }
  const packages = value.packages.map((entry, index) => parseRegistryEntry(entry, index))
  const identities = new Set<string>()
  for (const entry of packages) {
    const key = packageVersionKey(entry)
    if (identities.has(key)) throw new Error(`注册表包含重复软件包: ${key}`)
    identities.add(key)
  }
  return {
    id: registryDir,
    dir: registryDir,
    trust,
    schemaVersion: 1,
    generatedAt: value.generatedAt,
    packages
  }
}

function readRegistryTrust(
  registryDir: string,
  indexBytes: Buffer,
  trustedKeys: readonly TrustedRegistryKey[]
): 'official' | 'imported' {
  let text: string
  try {
    text = readFileSync(join(registryDir, 'index.sig.json'), 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'imported'
    throw new Error(`无法读取注册表签名文件 index.sig.json: ${errorMessage(error)}`)
  }

  let signature: ReturnType<typeof parseRegistrySignature>
  try {
    signature = parseRegistrySignature(JSON.parse(text) as unknown)
  } catch (error) {
    throw new Error(`注册表签名文件被拒绝: ${errorMessage(error)}`)
  }
  return verifyRegistryIndex(indexBytes, signature, trustedKeys)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

function parseRegistryEntry(value: unknown, index: number): RegistryPackageEntry {
  if (!isRecord(value)) throw new Error(`注册表 packages[${index}] 无效`)
  const entry = value as Record<string, unknown>
  if (
    typeof entry.id !== 'string' ||
    !/^[a-z][a-z0-9-]{1,63}$/.test(entry.id) ||
    (entry.type !== 'skill' &&
      entry.type !== 'plugin' &&
      entry.type !== 'wrapper' &&
      entry.type !== 'mcp') ||
    typeof entry.version !== 'string' ||
    !semver.valid(entry.version) ||
    typeof entry.title !== 'string' ||
    entry.title.length < 1 ||
    entry.title.length > 80 ||
    typeof entry.summary !== 'string' ||
    entry.summary.length < 1 ||
    entry.summary.length > 300 ||
    typeof entry.archive !== 'string' ||
    typeof entry.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.sha256) ||
    typeof entry.size !== 'number' ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0
  ) {
    throw new Error(`注册表 packages[${index}] 字段无效`)
  }
  if (entry.minAppVersion !== undefined && !semver.valid(String(entry.minAppVersion))) {
    throw new Error(`注册表 packages[${index}].minAppVersion 无效`)
  }
  const dependsOn = parseDependencies(entry.dependsOn, index)
  const requires = parseRequirements(entry.requires, index)
  return {
    id: entry.id,
    type: entry.type,
    version: entry.version,
    title: entry.title,
    summary: entry.summary,
    archive: entry.archive,
    sha256: entry.sha256,
    size: entry.size,
    dependsOn,
    ...(typeof entry.minAppVersion === 'string' ? { minAppVersion: entry.minAppVersion } : {}),
    ...(requires ? { requires } : {}),
    ...(typeof entry.category === 'string' ? { category: entry.category } : {}),
    ...(typeof entry.preview === 'string' ? { preview: entry.preview } : {})
  }
}

function parseDependencies(value: unknown, packageIndex: number): PackageDependency[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`注册表 packages[${packageIndex}].dependsOn 无效`)
  return value.map((dependency, index) => {
    if (
      !isRecord(dependency) ||
      typeof dependency.id !== 'string' ||
      !/^[a-z][a-z0-9-]{1,63}$/.test(dependency.id) ||
      (dependency.type !== 'skill' &&
        dependency.type !== 'plugin' &&
        dependency.type !== 'wrapper' &&
        dependency.type !== 'mcp') ||
      typeof dependency.version !== 'string' ||
      !semver.validRange(dependency.version)
    ) {
      throw new Error(`注册表 packages[${packageIndex}].dependsOn[${index}] 依赖或版本范围无效`)
    }
    return {
      id: dependency.id,
      type: dependency.type,
      version: dependency.version
    }
  })
}

function parseRequirements(value: unknown, packageIndex: number): PackageRequirements | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'coreTools')) {
    throw new Error(`注册表 packages[${packageIndex}].requires 无效`)
  }
  if (value.coreTools === undefined) return {}
  if (
    !Array.isArray(value.coreTools) ||
    value.coreTools.some((tool) => typeof tool !== 'string' || !/^[a-z][a-z0-9_]*$/.test(tool)) ||
    new Set(value.coreTools).size !== value.coreTools.length
  ) {
    throw new Error(`注册表 packages[${packageIndex}].requires.coreTools 无效`)
  }
  return { coreTools: value.coreTools as string[] }
}
