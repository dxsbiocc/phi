import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'

import {
  remoteAgentTrustState,
  type RemoteAgentTrustState
} from '../agents/remote-agent-trust-store'
import { RemoteWorkspaceTargetMissingError } from '../remote-workspace-boundary'
import type { RemoteSkillBundleFile, RemoteSkillSource } from '../remote-runtime/types'
import type { WorkspaceEntry, WorkspaceHost } from '../workspace-host/types'
import { validateSkill } from './skill'

export const MAX_REMOTE_PROJECT_SKILL_DIRECTORY_ENTRIES = 256
export const MAX_REMOTE_PROJECT_SKILL_FILE_BYTES = 16 * 1024 * 1024
export const MAX_REMOTE_PROJECT_SKILL_TOTAL_BYTES = 64 * 1024 * 1024
export const MAX_REMOTE_PROJECT_SKILL_FILES = 2_000
export const MAX_REMOTE_PROJECT_SKILL_DEPTH = 16
export const MAX_REMOTE_PROJECT_SKILL_MD_BYTES = 256 * 1024

const ROOTS = ['.phi/skills', '.omp/skills', '.pi/skills'] as const

export type RemoteProjectSkillTrustState = RemoteAgentTrustState | 'invalid'

export interface RemoteProjectSkillEntry {
  id: string
  name: string
  description: string
  relativePath: string
  contentHash: string
  trustState: RemoteProjectSkillTrustState
  available: boolean
  diagnostics: string[]
  content: string
  disableModelInvocation?: boolean
}

export interface RemoteProjectSkillSource extends RemoteSkillSource {
  files: readonly RemoteSkillBundleFile[]
  remoteProject: true
}

export interface RemoteProjectSkillDiagnostic {
  filePath: string
  message: string
  level: 'error' | 'warning'
}

export interface RemoteProjectSkillDiscoveryResult {
  sources: RemoteProjectSkillSource[]
  entries: RemoteProjectSkillEntry[]
  diagnostics: RemoteProjectSkillDiagnostic[]
}

export interface RemoteProjectSkillDiscoveryOptions {
  host: WorkspaceHost
  projectRoot: string
  hostAlias: string
  agentDir: string
}

function missingPath(error: unknown): boolean {
  return (
    error instanceof RemoteWorkspaceTargetMissingError ||
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') ||
    (error instanceof Error && /does not exist|目标不存在/u.test(error.message))
  )
}

function diagnostic(filePath: string, message: string): RemoteProjectSkillDiagnostic {
  return { filePath, message, level: 'error' }
}

async function rootEntries(
  host: WorkspaceHost,
  directory: string,
  diagnostics: RemoteProjectSkillDiagnostic[]
): Promise<readonly WorkspaceEntry[]> {
  try {
    const result = await host.fs.list(directory, {
      limit: MAX_REMOTE_PROJECT_SKILL_DIRECTORY_ENTRIES + 1
    })
    if (result.nextCursor || result.entries.length > MAX_REMOTE_PROJECT_SKILL_DIRECTORY_ENTRIES) {
      diagnostics.push(
        diagnostic(
          directory,
          `Skill 目录项超过 ${MAX_REMOTE_PROJECT_SKILL_DIRECTORY_ENTRIES} 个上限`
        )
      )
      return []
    }
    return result.entries
  } catch (error) {
    if (!missingPath(error)) {
      diagnostics.push(
        diagnostic(directory, error instanceof Error ? error.message : String(error))
      )
    }
    return []
  }
}

function checkedEntryName(name: string): string {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.includes('\uFFFD')
  ) {
    throw new Error('Skill 资源路径无效')
  }
  return name
}

async function readBundleFile(
  host: WorkspaceHost,
  remotePath: string,
  relativePath: string,
  remainingBytes: number
): Promise<RemoteSkillBundleFile> {
  const stat = await host.fs.stat(remotePath)
  if (stat.kind !== 'file') throw new Error(`Skill 资源不是普通文件：${relativePath}`)
  const fileLimit =
    relativePath === 'SKILL.md'
      ? MAX_REMOTE_PROJECT_SKILL_MD_BYTES
      : MAX_REMOTE_PROJECT_SKILL_FILE_BYTES
  const sizeError = (): Error =>
    new Error(
      relativePath === 'SKILL.md'
        ? 'SKILL.md 超过 256 KiB 上限'
        : `Skill 资源超过 ${MAX_REMOTE_PROJECT_SKILL_FILE_BYTES} 字节单文件上限：${relativePath}`
    )
  if (stat.size > fileLimit) throw sizeError()
  if (stat.size > remainingBytes) throw new Error('Skill 资源超过总字节上限')
  const read = await host.fs.readRange(remotePath, {
    offset: 0,
    length: fileLimit + 1
  })
  if (!read.eof) {
    throw sizeError()
  }
  if (read.bytesRead > fileLimit) {
    throw sizeError()
  }
  const content = Buffer.from(read.content)
  if (content.length > fileLimit) throw sizeError()
  if (content.length > remainingBytes) throw new Error('Skill 资源超过总字节上限')
  return {
    relativePath,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    executable: relativePath.startsWith('scripts/')
  }
}

async function readSkillSnapshot(
  host: WorkspaceHost,
  skillDirectory: string
): Promise<RemoteSkillBundleFile[]> {
  const files: RemoteSkillBundleFile[] = []
  let totalBytes = 0
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_REMOTE_PROJECT_SKILL_DEPTH) {
      throw new Error(`Skill 资源目录深度超过 ${MAX_REMOTE_PROJECT_SKILL_DEPTH} 层上限`)
    }
    const listed = await host.fs.list(directory, {
      limit: MAX_REMOTE_PROJECT_SKILL_DIRECTORY_ENTRIES + 1
    })
    if (listed.nextCursor || listed.entries.length > MAX_REMOTE_PROJECT_SKILL_DIRECTORY_ENTRIES) {
      throw new Error(
        `Skill 资源单目录条目超过 ${MAX_REMOTE_PROJECT_SKILL_DIRECTORY_ENTRIES} 个上限`
      )
    }
    for (const entry of listed.entries) {
      const name = checkedEntryName(entry.name)
      const remotePath = posix.join(directory, name)
      const relativePath = prefix ? posix.join(prefix, name) : name
      if (entry.kind === 'directory') {
        await walk(remotePath, relativePath, depth + 1)
        continue
      }
      if (entry.kind !== 'file') throw new Error(`Skill 资源类型不受支持：${relativePath}`)
      if (files.length >= MAX_REMOTE_PROJECT_SKILL_FILES) {
        throw new Error(`Skill 资源文件超过 ${MAX_REMOTE_PROJECT_SKILL_FILES} 个上限`)
      }
      const file = await readBundleFile(
        host,
        remotePath,
        relativePath,
        MAX_REMOTE_PROJECT_SKILL_TOTAL_BYTES - totalBytes
      )
      files.push(file)
      totalBytes += file.content.length
    }
  }
  await walk(skillDirectory, '', 0)
  files.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  )
  return files
}

function textOf(file: RemoteSkillBundleFile): string {
  if (file.content.includes(0)) throw new Error('SKILL.md 是二进制内容')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(file.content)
  } catch {
    throw new Error('SKILL.md 不是有效 UTF-8 文本')
  }
}

function bundleHash(files: readonly RemoteSkillBundleFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.relativePath).update('\0')
    hash.update(file.executable ? '755' : '600').update('\0')
    hash.update(String(file.content.length)).update('\0')
    hash.update(file.content)
  }
  return hash.digest('hex')
}

function invalidEntry(options: {
  directoryName: string
  relativePath: string
  contentHash: string
  content: string
  messages: string[]
}): RemoteProjectSkillEntry {
  return {
    id: `remote-project:${options.relativePath}:${options.contentHash}`,
    name: options.directoryName,
    description: '服务器项目 Skill 定义无效',
    relativePath: options.relativePath,
    contentHash: options.contentHash,
    trustState: 'invalid',
    available: false,
    diagnostics: options.messages,
    content: options.content
  }
}

function validateSnapshot(
  directoryName: string,
  files: readonly RemoteSkillBundleFile[]
): ReturnType<typeof validateSkill> {
  const directory = mkdtempSync(join(tmpdir(), 'phi-remote-project-skill-'))
  try {
    for (const file of files) {
      const path = join(directory, file.relativePath)
      mkdirSync(posix.dirname(path), { recursive: true })
      writeFileSync(path, file.content)
      if (file.executable) chmodSync(path, 0o700)
    }
    return validateSkill(directory, { expectedName: directoryName })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export async function discoverRemoteProjectSkills(
  options: RemoteProjectSkillDiscoveryOptions
): Promise<RemoteProjectSkillDiscoveryResult> {
  const sources: RemoteProjectSkillSource[] = []
  const entries: RemoteProjectSkillEntry[] = []
  const diagnostics: RemoteProjectSkillDiagnostic[] = []

  for (const root of ROOTS) {
    for (const directoryEntry of await rootEntries(options.host, root, diagnostics)) {
      if (directoryEntry.kind !== 'directory') continue
      const directory = posix.join(root, directoryEntry.name)
      const relativePath = posix.join(directory, 'SKILL.md')
      try {
        const files = await readSkillSnapshot(options.host, directory)
        const skillFile = files.find((file) => file.relativePath === 'SKILL.md')
        if (!skillFile) throw new Error('SKILL.md is required')
        const contentHash = bundleHash(files)
        let content: string
        try {
          content = textOf(skillFile)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          diagnostics.push(diagnostic(posix.join(options.projectRoot, relativePath), message))
          entries.push(
            invalidEntry({
              directoryName: directoryEntry.name,
              relativePath,
              contentHash,
              content: '',
              messages: [message]
            })
          )
          continue
        }
        const validation = validateSnapshot(directoryEntry.name, files)
        const messages = [...validation.errors, ...validation.warnings].map(
          (problem) => `${problem.path}: ${problem.message}`
        )
        for (const problem of [...validation.errors, ...validation.warnings]) {
          diagnostics.push({
            filePath: posix.join(options.projectRoot, relativePath),
            level: problem.level,
            message: `${problem.path}: ${problem.message}`
          })
        }
        if (!validation.ok || !validation.skill) {
          entries.push(
            invalidEntry({
              directoryName: directoryEntry.name,
              relativePath,
              contentHash,
              content,
              messages
            })
          )
          continue
        }
        const trustState = remoteAgentTrustState(
          {
            hostAlias: options.hostAlias,
            projectRoot: options.projectRoot,
            relativePath,
            contentHash
          },
          options.agentDir
        )
        const trustMessage =
          trustState === 'trusted'
            ? undefined
            : trustState === 'changed'
              ? '来自服务器项目，内容已变化，需要重新信任'
              : '来自服务器项目，未信任'
        const entry: RemoteProjectSkillEntry = {
          id: `remote-project:${relativePath}:${contentHash}`,
          name: validation.skill.name,
          description: validation.skill.description,
          relativePath,
          contentHash,
          trustState,
          available: trustState === 'trusted',
          diagnostics: [...messages, ...(trustMessage ? [trustMessage] : [])],
          content,
          ...(validation.skill.frontmatter['disable-model-invocation'] === true
            ? { disableModelInvocation: true }
            : {})
        }
        entries.push(entry)
        if (trustState === 'trusted') {
          if (sources.some((source) => source.name === validation.skill!.name)) {
            entry.available = false
            entry.diagnostics.push('同名的更高优先级服务器项目 Skill 已生效')
          } else {
            sources.push({
              name: validation.skill.name,
              filePath: relativePath,
              dir: directory,
              insidePlugin: false,
              files,
              remoteProject: true
            })
          }
        }
      } catch (error) {
        diagnostics.push(
          diagnostic(
            posix.join(options.projectRoot, relativePath),
            error instanceof Error ? error.message : String(error)
          )
        )
      }
    }
  }

  return { sources, entries, diagnostics }
}
