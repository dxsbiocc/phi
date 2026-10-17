import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import semver from 'semver'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { parseSkillFile } from '../content/skill'
import {
  discoverSkillSources,
  skillSourceCategory,
  type SkillSource
} from '../content/skill-sources'
import { materializeWrapperRegistry } from '../wrappers/packages/builder'
import type { LocalRegistry, RegistryPackageEntry } from './installer-types'
import { errorMessage, isRecord } from './installer-utils'
import { materializeRegistry, regularPackageFiles } from './materialize-registry'
import { parsePackageManifestText, type PackageType } from './manifest'
import { OFFICIAL_REGISTRY_ID } from './official-registry'

interface WebsiteMaterializeOptions {
  sourceDir: string
  stagingDir: string
  generatedAt: string
  expectedSkillCount: number
}

/** Copy and validate content; repository scripts are only archived, never executed. */
export function materializeOfficialWebsite(options: WebsiteMaterializeOptions): {
  registry: LocalRegistry
  notices: string[]
} {
  const outDir = join(options.stagingDir, 'registry')
  const packages: RegistryPackageEntry[] = []
  const notices: string[] = []
  for (const [directory, type] of [
    ['skills', 'skill'],
    ['connectors', 'mcp'],
    ['plugins', 'plugin']
  ] as const) {
    const root = join(options.sourceDir, 'resources', directory)
    const sources: SkillSource[] =
      type === 'skill' ? discoverSkillSources(root) : childDirectories(root).map((dir) => ({ dir }))
    for (const source of sources) {
      const packageDir = source.dir
      try {
        const copied = copyPackageSource(packageDir, options.stagingDir, type)
        const registry = materializeRegistry([copied], outDir, {
          id: OFFICIAL_REGISTRY_ID,
          generatedAt: options.generatedAt,
          allowedTypes: [type]
        })
        if (type === 'skill') {
          const parsed = parseSkillFile(readFileSync(join(copied, 'SKILL.md'), 'utf8'))
          if (!parsed.ok) throw new Error(parsed.error)
          const category = skillSourceCategory(parsed.frontmatter, source.category)
          packages.push(
            ...registry.packages.map((entry) => ({ ...entry, ...(category ? { category } : {}) }))
          )
        } else {
          packages.push(...registry.packages)
        }
      } catch (error) {
        if (type === 'skill') throw error
        notices.push(`${type}/${basename(packageDir)}：${errorMessage(error).slice(0, 180)}`)
      }
    }
  }
  if (packages.filter((entry) => entry.type === 'skill').length !== options.expectedSkillCount) {
    throw new Error('官网技能数量与固定提交中的完整技能目录不一致')
  }
  const wrappersRoot = join(options.sourceDir, 'resources', 'wrappers')
  if (directoryExists(wrappersRoot)) {
    try {
      const wrappers = materializeWrapperRegistry({
        wrappersRoot,
        outDir,
        generatedAt: options.generatedAt,
        writeIndex: false
      })
      const wrapperKinds = new Map(
        wrappers.sources.map((source) => [source.manifest.id, source.kind])
      )
      packages.push(
        ...wrappers.index.packages.map((entry) => {
          const kind = wrapperKinds.get(entry.id)
          const category =
            kind === 'module'
              ? 'modules'
              : kind === 'subworkflow'
                ? 'subworkflows'
                : kind === 'workflow'
                  ? 'workflows'
                  : 'support'
          return { ...entry, category }
        })
      )
      if (wrappers.diagnostics.unattributedIncludes.length) {
        notices.push(`wrapper：${wrappers.diagnostics.unattributedIncludes.length} 个引用无法归属`)
      }
    } catch (error) {
      notices.push(`wrapper：${errorMessage(error).slice(0, 180)}`)
    }
  }
  packages.sort((left, right) =>
    `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`)
  )
  const identities = packages.map((entry) => `${entry.type}:${entry.id}`)
  if (new Set(identities).size !== identities.length) throw new Error('官网目录包含重复的软件包')
  mkdirSync(outDir, { recursive: true })
  const index = { schemaVersion: 1 as const, generatedAt: options.generatedAt, packages }
  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
  return {
    registry: { id: OFFICIAL_REGISTRY_ID, dir: outDir, trust: 'imported', ...index },
    notices
  }
}

function childDirectories(root: string): string[] {
  if (!directoryExists(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      const path = join(root, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`官网资源目录不允许符号链接：${entry.name}`)
      return stat.isDirectory() ? path : undefined
    })
    .filter((path): path is string => path !== undefined)
    .sort()
}

function directoryExists(path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('官网资源目录不安全')
    return true
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function copyPackageSource(source: string, stagingDir: string, type: PackageType): string {
  const id = basename(source)
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error('官网资源名称无效')
  const target = join(stagingDir, 'sources', type, id)
  const files = regularPackageFiles(source)
  for (const file of files) {
    const path = join(target, ...file.path.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.data, { flag: 'wx', mode: file.mode })
  }
  if (type === 'skill') {
    const parsed = parseSkillFile(readFileSync(join(target, 'SKILL.md'), 'utf8'))
    if (!parsed.ok) throw new Error(parsed.error)
    if (
      parsed.frontmatter.name !== id ||
      typeof parsed.frontmatter.description !== 'string' ||
      !parsed.frontmatter.description.trim()
    ) {
      throw new Error(`官网技能名称或说明无效：${id}`)
    }
    const metadata = isRecord(parsed.frontmatter.metadata) ? parsed.frontmatter.metadata : {}
    const manifestPath = join(target, 'phi-package.yaml')
    const existingManifest = files.some((file) => file.path === 'phi-package.yaml')
      ? (parseYaml(readFileSync(manifestPath, 'utf8')) as unknown)
      : undefined
    if (existingManifest !== undefined && !isRecord(existingManifest)) {
      throw new Error('官网技能软件包清单无效')
    }
    const manifest =
      existingManifest !== undefined
        ? {
            ...existingManifest,
            version: normalizedSkillVersion(existingManifest.version)
          }
        : {
            schemaVersion: 1,
            id,
            type: 'skill',
            version: normalizedSkillVersion(metadata.version),
            title: id.slice(0, 80),
            summary: parsed.frontmatter.description.slice(0, 300),
            files: 'files.json'
          }
    writeFileSync(manifestPath, stringifyYaml(manifest))
  }
  const manifest = parsePackageManifestText(readFileSync(join(target, 'phi-package.yaml'), 'utf8'))
  if (manifest.type !== type || manifest.id !== id) throw new Error('官网资源与软件包身份不一致')
  return target
}

function normalizedSkillVersion(value: unknown): string {
  if (value === undefined) return '1.0.0'
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('官网技能版本无效')
  const candidate = String(value)
  const valid = semver.valid(candidate)
  if (valid) return valid
  // Official skill metadata uses "1.1"; only numeric short forms can be coerced.
  const coerced = /^\d+(?:\.\d+){0,2}$/.test(candidate) ? semver.coerce(candidate) : null
  if (!coerced) throw new Error('官网技能版本无效')
  return coerced.version
}
