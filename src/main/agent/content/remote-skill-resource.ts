import { readFileSync, readdirSync, realpathSync, statSync, type Dirent, type Stats } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { RemoteWorkspaceReadResult } from '../remote-workspace-read'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 1000

export type RemoteReadableSkill = {
  name: string
  filePath: string
  baseDir: string
  containRoot?: string
}

export function readRemoteSkillResource(
  uri: string,
  skills: readonly RemoteReadableSkill[]
): RemoteWorkspaceReadResult {
  const parsed = parseSkillUri(uri)
  const skill = skills.find((candidate) => candidate.name === parsed.name)
  if (!skill) throw new Error(`Unknown skill: ${parsed.name}`)
  const target = parsed.relativePath
    ? resolveSkillPath(skill, parsed.relativePath)
    : containedRealPath(skill.containRoot ?? skill.baseDir, skill.filePath)
  const info = resourceStat(target)
  if (info.isDirectory()) return directoryResult(uri, target)
  if (!info.isFile()) throw new Error(`skill:// target is not a file or directory: ${uri}`)
  if (info.size > MAX_FILE_BYTES) throw new Error('skill:// file exceeds the 1 MiB read limit')
  const bytes = resourceBytes(target)
  if (bytes.includes(0)) throw new Error('skill:// resource is binary')
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return {
    kind: 'file',
    path: uri,
    content,
    fileSize: bytes.length,
    contentType: contentType(target)
  }
}

function parseSkillUri(uri: string): { name: string; relativePath?: string } {
  const match = /^skill:\/\/([^/?#]+)(\/[^?#]*)?$/u.exec(uri)
  if (!match) throw new Error('Invalid skill:// URL')
  const name = decodePart(match[1], 'skill name')
  const encodedPath = match[2]?.slice(1)
  if (!encodedPath) return { name }
  const relativePath = encodedPath
    .split('/')
    .map((part) => decodePart(part, 'skill path'))
    .join('/')
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/u).includes('..') ||
    relativePath.includes('\0')
  ) {
    throw new Error('Path traversal is not allowed in skill:// URLs')
  }
  return { name, relativePath }
}

function decodePart(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
      throw new Error(`Invalid ${label}`)
    }
    return decoded
  } catch {
    throw new Error(`Invalid ${label}`)
  }
}

function resolveSkillPath(skill: RemoteReadableSkill, relativePath: string): string {
  const target = resolve(skill.baseDir, relativePath)
  const lexical = relative(skill.baseDir, target)
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error('Path traversal is not allowed in skill:// URLs')
  }
  return containedRealPath(skill.containRoot ?? skill.baseDir, target)
}

function containedRealPath(root: string, target: string): string {
  let realRoot: string
  let realTarget: string
  try {
    realRoot = realpathSync(root)
    realTarget = realpathSync(target)
  } catch {
    throw new Error('skill:// resource does not exist')
  }
  const part = relative(realRoot, realTarget)
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new Error('skill:// path resolves outside the skill root')
  }
  return realTarget
}

function directoryResult(uri: string, target: string): RemoteWorkspaceReadResult {
  let entries: Dirent[]
  try {
    entries = readdirSync(target, { withFileTypes: true })
  } catch {
    throw new Error('skill:// directory is not readable')
  }
  if (entries.length > MAX_DIRECTORY_ENTRIES)
    throw new Error('skill:// directory has too many entries')
  const visible = entries.filter((entry) => entry.isFile() || entry.isDirectory())
  visible.sort(entryOrder)
  return {
    kind: 'directory',
    path: uri,
    content: visible.map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`).join('\n'),
    entries: visible.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  }
}

function entryOrder(left: Dirent, right: Dirent): number {
  return (
    Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name)
  )
}

function contentType(path: string): string {
  const extension = extname(path).toLowerCase()
  if (extension === '.md' || extension === '.mdx' || extension === '.markdown') {
    return 'text/markdown'
  }
  return extension === '.json' ? 'application/json' : 'text/plain'
}

function resourceStat(path: string): Stats {
  try {
    return statSync(path)
  } catch {
    throw new Error('skill:// resource is not readable')
  }
}

function resourceBytes(path: string): Buffer {
  try {
    return readFileSync(path)
  } catch {
    throw new Error('skill:// resource is not readable')
  }
}
