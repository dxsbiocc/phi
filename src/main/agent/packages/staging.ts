import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { parseTarGz } from './archive'
import { getPhiAgentDir } from '../runtime-paths'
import type {
  LocalRegistry,
  PackageSourceMetadata,
  PlannedPackage,
  RegistryPackageEntry,
  StagedPackage
} from './installer-types'
import {
  assertSafePackagePath,
  compareText,
  errorCode,
  errorMessage,
  isRecord,
  localArchivePath,
  sha256
} from './installer-utils'
import { readPackageManifest, validatePackage } from './manifest'

interface FilesList {
  version: 1
  files: Array<{ path: string; sha256: string; size: number }>
}

const DAY_MS = 24 * 60 * 60 * 1000

export function cleanupStalePackageStaging(
  options: {
    agentDir?: string
    now?: () => Date
  } = {}
): string[] {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const stagingRoot = join(agentDir, '.staging')
  let names: string[]
  try {
    names = readdirSync(stagingRoot)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
  const cutoff = (options.now?.() ?? new Date()).getTime() - DAY_MS
  const removed: string[] = []
  for (const name of names) {
    const path = join(stagingRoot, name)
    if (lstatSync(path).mtimeMs >= cutoff) continue
    rmSync(path, { recursive: true, force: true })
    removed.push(path)
  }
  return removed.sort()
}

export function stagePackage(
  registry: LocalRegistry,
  entry: PlannedPackage,
  agentDir: string,
  now?: () => Date
): StagedPackage {
  const archivePath = localArchivePath(registry, entry.archive)
  const archive = readFileSync(archivePath)
  if (archive.length !== entry.size) {
    throw new Error(`软件包 ${entry.id} 归档大小不匹配: 期望 ${entry.size}，实际 ${archive.length}`)
  }
  const digest = sha256(archive)
  if (digest !== entry.sha256) {
    throw new Error(`软件包 ${entry.id} 归档 SHA-256 哈希不匹配`)
  }
  const entries = parseTarGz(archive)
  const seen = new Set<string>()
  for (const item of entries) {
    if (item.type === 'directory') item.path = item.path.replace(/\/+$/, '')
    assertSafePackagePath(item.path)
    if (seen.has(item.path)) throw new Error(`归档包含重复路径: ${item.path}`)
    seen.add(item.path)
    if (item.type === 'link') throw new Error(`归档不允许链接条目: ${item.path}`)
    if (item.type !== 'file' && item.type !== 'directory') {
      throw new Error(`归档包含不支持的条目类型: ${item.path}`)
    }
  }

  const stagingRoot = join(agentDir, '.staging')
  mkdirSync(stagingRoot, { recursive: true })
  const dir = join(stagingRoot, randomUUID())
  mkdirSync(dir, { recursive: false })
  try {
    for (const item of entries) {
      const target = join(dir, ...item.path.split('/'))
      if (item.type === 'directory') mkdirSync(target, { recursive: true })
      else {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, item.data, { flag: 'wx' })
      }
    }
    verifyStagedPackage(dir, entry)
    const source: PackageSourceMetadata = {
      registry: registry.id,
      id: entry.id,
      type: entry.type,
      version: entry.version,
      sha256: entry.sha256,
      installedAt: (now?.() ?? new Date()).toISOString(),
      installedBy: entry.installedBy
    }
    return { entry, dir, source }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

function verifyStagedPackage(dir: string, entry: RegistryPackageEntry): void {
  const filesList = readFilesList(join(dir, 'files.json'))
  const listed = new Map(filesList.files.map((file) => [file.path, file]))
  const actual = listRegularFiles(dir)
  for (const path of actual) {
    if (path === 'files.json') continue
    const expected = listed.get(path)
    if (!expected) throw new Error(`文件 ${path} 未列入 files.json`)
    const data = readFileSync(join(dir, ...path.split('/')))
    if (data.length !== expected.size) throw new Error(`文件 ${path} 大小与 files.json 不匹配`)
    if (sha256(data) !== expected.sha256) throw new Error(`文件 ${path} 哈希与 files.json 不匹配`)
  }
  for (const file of filesList.files) {
    const path = join(dir, ...file.path.split('/'))
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`files.json 列出的文件不存在: ${file.path}`)
    }
  }

  const manifest = readPackageManifest(dir)
  if (
    manifest.id !== entry.id ||
    manifest.type !== entry.type ||
    manifest.version !== entry.version
  ) {
    throw new Error(`软件包清单与注册表不匹配: 期望 ${entry.type}:${entry.id}@${entry.version}`)
  }
  const validation = validatePackage(dir)
  if (!validation.ok) {
    throw new Error(
      `软件包类型验证失败: ${validation.errors
        .map((problem) => `${problem.path}: ${problem.message}`)
        .join('; ')}`
    )
  }
}

function readFilesList(path: string): FilesList {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`无法读取 files.json: ${errorMessage(error)}`)
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.files)) {
    throw new Error('files.json 格式无效')
  }
  const seen = new Set<string>()
  const files = value.files.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.path !== 'string' ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0
    ) {
      throw new Error(`files.json 第 ${index + 1} 项无效`)
    }
    assertSafePackagePath(item.path)
    if (item.path === 'files.json') throw new Error('files.json 不得列出自身')
    if (seen.has(item.path)) throw new Error(`files.json 包含重复路径: ${item.path}`)
    seen.add(item.path)
    return { path: item.path, sha256: item.sha256, size: item.size }
  })
  const sorted = [...files].sort((left, right) => compareText(left.path, right.path))
  if (files.some((file, index) => file.path !== sorted[index]?.path)) {
    throw new Error('files.json 路径必须排序')
  }
  return { version: 1, files }
}

function listRegularFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort(compareText)) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      const relativePath = relative(root, path).split('\\').join('/')
      if (stat.isSymbolicLink()) throw new Error(`暂存目录不允许链接: ${relativePath}`)
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) files.push(relativePath)
      else throw new Error(`暂存目录包含非普通文件: ${relativePath}`)
    }
  }
  walk(root)
  return files.sort(compareText)
}
