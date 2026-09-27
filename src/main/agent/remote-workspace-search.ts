import { posix } from 'node:path'

import {
  withAuthorizedRemoteWorkspacePath,
  type AuthorizedRemoteWorkspacePath,
  type RemoteWorkspaceBoundaryDependencies
} from './remote-workspace-boundary'
import { readRemoteWorkspacePath } from './remote-workspace-read'
import {
  shellQuote,
  type RemoteExecBoundedResult,
  type RemoteSshSession
} from './wrappers/remote-ssh-session'

const SEARCH_TIMEOUT_MS = 30_000
const SEARCH_OUTPUT_BYTES = 512 * 1024
const GLOB_LIMIT = 200
const GREP_FILE_LIMIT = 20
const GREP_MATCH_LIMIT = 400
const FALLBACK_FILE_LIMIT = 1000

export interface RemoteGlobRequest {
  sessionId: string
  projectId: string
  path?: string
  hidden?: boolean
  gitignore?: boolean
  limit?: number
}

export interface RemoteGlobResult {
  paths: string[]
  content: string
  truncated: boolean
  engine: 'rg' | 'find'
  gitignoreApplied: boolean
}

export interface RemoteGrepRequest {
  sessionId: string
  projectId: string
  pattern: string
  path?: string
  case?: boolean
  gitignore?: boolean
  skip?: number | null
}

export interface RemoteGrepMatch {
  path: string
  line: number
  text: string
}

export interface RemoteGrepResult {
  matches: RemoteGrepMatch[]
  content: string
  fileCount: number
  matchCount: number
  truncated: boolean
  engine: 'rg' | 'find-grep' | 'bounded-text' | 'mixed'
  gitignoreApplied: boolean
}

type SearchScope = { base: string; pattern: string | null }

function requestRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('远程搜索请求无效')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error('远程搜索请求包含未授权字段')
  }
  if (
    typeof record.sessionId !== 'string' ||
    !record.sessionId ||
    typeof record.projectId !== 'string' ||
    !record.projectId
  ) {
    throw new Error('远程搜索必须绑定 Phi 会话和项目 ID')
  }
  return record
}

function scopeFromPath(raw: string): SearchScope {
  if (!raw || raw.includes('\0') || /^ssh:\/\//i.test(raw) || raw.split('/').includes('..')) {
    throw new Error('远程搜索路径无效')
  }
  const magic = raw.search(/[*?[{]/)
  if (magic < 0) return { base: raw, pattern: null }
  const slash = raw.lastIndexOf('/', magic)
  return {
    base: slash < 0 ? '.' : raw.slice(0, slash) || '/',
    pattern: raw.slice(slash + 1)
  }
}

function inside(root: string, candidate: string): boolean {
  const nested = posix.relative(root, candidate)
  return (
    nested === '' || (nested !== '..' && !nested.startsWith('../') && !posix.isAbsolute(nested))
  )
}

function remoteUri(hostAlias: string, path: string): string {
  return `ssh://${hostAlias}${path.split('/').map(encodeURIComponent).join('/')}`
}

function physicalScopeCommand(authorized: AuthorizedRemoteWorkspacePath, body: string): string {
  const script = [
    'set -eu',
    `cd -P -- ${shellQuote(authorized.path)} || exit 72`,
    `root=${shellQuote(authorized.canonicalRoot)}`,
    'if [ "$root" != / ]; then case "$PWD" in "$root"|"$root"/*) ;; *) exit 72 ;; esac; fi',
    body
  ].join('\n')
  return `bash -c ${shellQuote(script)}`
}

async function bounded(
  session: RemoteSshSession,
  command: string
): Promise<RemoteExecBoundedResult> {
  if (!session.execBounded) throw new Error('当前 SSH 连接不支持有界远程搜索')
  return session.execBounded(command, {
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxOutputBytes: SEARCH_OUTPUT_BYTES
  })
}

async function hasRg(session: RemoteSshSession): Promise<boolean> {
  return (await session.exec('command -v rg >/dev/null 2>&1')).code === 0
}

function nulPaths(output: RemoteExecBoundedResult): { paths: string[]; truncated: boolean } {
  if (output.stdout.includes('\uFFFD')) throw new Error('远程搜索返回非 UTF-8 路径')
  const chunks = output.stdout.split('\0')
  const complete = chunks.at(-1) === ''
  if (!complete && !output.stdoutTruncated) throw new Error('远程搜索路径格式无效')
  return {
    paths: chunks.slice(0, -1).filter(Boolean),
    truncated: output.stdoutTruncated || !complete
  }
}

function matchGlob(pattern: string, relativePath: string): boolean {
  if (hasAdvancedGlob(pattern)) {
    throw new Error('服务器没有 rg 时仅支持 *、** 和 ? 通配符；请缩小搜索或安装 rg')
  }
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          expression += '(?:.*/)?'
        } else expression += '.*'
      } else expression += '[^/]*'
    } else if (character === '?') expression += '[^/]'
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  expression += '$'
  const target = pattern.includes('/') ? relativePath : posix.basename(relativePath)
  return new RegExp(expression).test(target)
}

function hasAdvancedGlob(pattern: string): boolean {
  return ['[', ']', '{', '}'].some((character) => pattern.includes(character))
}

function checkedRelativePath(scope: AuthorizedRemoteWorkspacePath, raw: string): string {
  const relative = raw.replace(/^\.\//, '')
  if (!relative || relative.includes('\0') || relative.split('/').includes('..')) {
    throw new Error('远程搜索返回越界路径')
  }
  const absolute = posix.join(scope.path, relative)
  if (!inside(scope.canonicalRoot, absolute)) throw new Error('远程搜索返回越界路径')
  return absolute
}

async function collectFiles(
  session: RemoteSshSession,
  scope: AuthorizedRemoteWorkspacePath,
  pattern: string,
  options: { hidden: boolean; gitignore: boolean }
): Promise<{
  paths: string[]
  truncated: boolean
  engine: 'rg' | 'find'
  gitignoreApplied: boolean
}> {
  const rg = await hasRg(session)
  if (!rg) matchGlob(pattern, 'probe') // validate fallback grammar before scanning
  const body = rg
    ? `rg --files -0 ${options.hidden ? '--hidden' : ''} ${options.gitignore ? '' : '--no-ignore'} -g ${shellQuote(pattern)} ${options.hidden ? '' : "-g '!.*' -g '!**/.*'"} -- .`
    : `find . -type f ${options.hidden ? '' : "! -path '*/.*'"} -print0`
  const result = await bounded(session, physicalScopeCommand(scope, body))
  if (result.code !== 0 && !(rg && result.code === 1)) {
    throw new Error('远程 glob 搜索失败；请检查目录权限和通配符')
  }
  const parsed = nulPaths(result)
  const filePaths = parsed.paths
    .filter((path) => rg || matchGlob(pattern, path.replace(/^\.\//, '')))
    .map((path) => checkedRelativePath(scope, path))
  let directoryPaths: string[] = []
  let directoryTruncated = false
  if (!hasAdvancedGlob(pattern) && !posix.basename(pattern).includes('.')) {
    const directoryCommand = physicalScopeCommand(
      scope,
      `find . -mindepth 1 -type d ${options.hidden ? '' : "! -path '*/.*'"} -print0`
    )
    const directories = await bounded(session, directoryCommand)
    if (directories.code !== 0) throw new Error('远程 glob 目录搜索失败；请检查目录权限')
    const parsedDirectories = nulPaths(directories)
    directoryTruncated = parsedDirectories.truncated
    directoryPaths = parsedDirectories.paths
      .filter((path) => matchGlob(pattern.replace(/\/$/, ''), path.replace(/^\.\//, '')))
      .map((path) => `${checkedRelativePath(scope, path)}/`)
  }
  return {
    paths: [...filePaths, ...directoryPaths],
    truncated: parsed.truncated || directoryTruncated,
    engine: rg ? 'rg' : 'find',
    gitignoreApplied: rg && options.gitignore
  }
}

export async function remoteGlob(
  input: unknown,
  dependencies: RemoteWorkspaceBoundaryDependencies = {}
): Promise<RemoteGlobResult> {
  const request = requestRecord(input, [
    'sessionId',
    'projectId',
    'path',
    'hidden',
    'gitignore',
    'limit'
  ])
  if (
    (request.path !== undefined && typeof request.path !== 'string') ||
    (request.hidden !== undefined && typeof request.hidden !== 'boolean') ||
    (request.gitignore !== undefined && typeof request.gitignore !== 'boolean') ||
    (request.limit !== undefined &&
      (typeof request.limit !== 'number' || !Number.isInteger(request.limit) || request.limit < 1))
  ) {
    throw new Error('远程 glob 参数无效')
  }
  const paths = (typeof request.path === 'string' ? request.path : '.')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
  if (paths.length === 0 || paths.length > 8) throw new Error('远程 glob 路径数量无效')
  const limit = Math.min((request.limit as number | undefined) ?? GLOB_LIMIT, GLOB_LIMIT)
  const found = new Set<string>()
  let truncated = false
  let engine: 'rg' | 'find' = 'rg'
  let gitignoreApplied = true
  let hostAlias = ''
  for (const rawPath of paths) {
    const { base, pattern } = scopeFromPath(rawPath)
    const part = await withAuthorizedRemoteWorkspacePath(
      { sessionId: request.sessionId, projectId: request.projectId, path: base, mode: 'existing' },
      async (authorized, session) => {
        const directory = (await session.exec(`test -d ${shellQuote(authorized.path)}`)).code === 0
        if (!directory && pattern) throw new Error('通配符的远端基目录不是文件夹')
        if (!directory)
          return {
            paths: [authorized.path],
            truncated: false,
            engine: 'rg' as const,
            gitignoreApplied: true,
            hostAlias: authorized.hostAlias
          }
        const found = await collectFiles(session, authorized, pattern ?? '**/*', {
          hidden: request.hidden === true,
          gitignore: request.gitignore !== false
        })
        return { ...found, hostAlias: authorized.hostAlias }
      },
      dependencies
    )
    for (const path of part.paths) found.add(path)
    hostAlias = part.hostAlias
    truncated ||= part.truncated
    if (part.engine === 'find') engine = 'find'
    gitignoreApplied &&= part.gitignoreApplied
  }
  const sorted = [...found].sort((left, right) => left.localeCompare(right))
  truncated ||= sorted.length > limit
  const selected = sorted.slice(0, limit)
  const uris = selected.map((path) => remoteUri(hostAlias, path))
  return {
    paths: uris,
    content: [
      ...(uris.length ? uris : [truncated ? '(no matches in inspected prefix)' : '(no matches)']),
      ...(truncated ? ['[results truncated; narrow path]'] : []),
      ...(engine === 'find' && request.gitignore !== false
        ? ['[gitignore not applied: rg unavailable]']
        : [])
    ].join('\n'),
    truncated,
    engine,
    gitignoreApplied: gitignoreApplied && request.gitignore !== false
  }
}

function parseRgMatches(
  output: RemoteExecBoundedResult,
  scope: AuthorizedRemoteWorkspacePath
): { matches: RemoteGrepMatch[]; truncated: boolean } {
  const lines = output.stdout.split('\n')
  const complete = !output.stdout || output.stdout.endsWith('\n')
  if (!complete) lines.pop()
  const matches: RemoteGrepMatch[] = []
  for (const line of lines) {
    if (!line) continue
    let item: Record<string, unknown>
    try {
      item = JSON.parse(line) as Record<string, unknown>
    } catch {
      throw new Error('远程 rg 返回格式无效')
    }
    if (item.type !== 'match' || typeof item.data !== 'object' || item.data === null) continue
    const data = item.data as Record<string, unknown>
    const path = data.path as Record<string, unknown> | undefined
    const text = data.lines as Record<string, unknown> | undefined
    if (
      typeof path?.text !== 'string' ||
      typeof text?.text !== 'string' ||
      typeof data.line_number !== 'number'
    ) {
      throw new Error('远程 rg 匹配格式无效')
    }
    matches.push({
      path: checkedRelativePath(scope, path.text),
      line: data.line_number,
      text: text.text.replace(/\r?\n$/, '')
    })
  }
  return { matches, truncated: output.stdoutTruncated || !complete }
}

function parseFallbackMatches(
  output: RemoteExecBoundedResult,
  scope: AuthorizedRemoteWorkspacePath
): { matches: RemoteGrepMatch[]; truncated: boolean } {
  if (output.stdout.includes('\uFFFD')) throw new Error('远程 grep 返回非 UTF-8 路径或文本')
  const fields = output.stdout.split('\0')
  const complete = fields.at(-1) === ''
  const matches: RemoteGrepMatch[] = []
  for (let index = 0; index + 1 < fields.length - 1; index += 2) {
    const line = fields[index + 1]
    const separator = line.indexOf(':')
    const number = Number(line.slice(0, separator))
    if (separator < 1 || !Number.isInteger(number) || number < 1)
      throw new Error('远程 grep 返回格式无效')
    matches.push({
      path: checkedRelativePath(scope, fields[index]),
      line: number,
      text: line.slice(separator + 1)
    })
  }
  return { matches, truncated: output.stdoutTruncated || !complete }
}

async function fallbackGrep(
  session: RemoteSshSession,
  scope: AuthorizedRemoteWorkspacePath,
  pattern: string,
  fileGlob: string | null,
  caseSensitive: boolean
): Promise<{ matches: RemoteGrepMatch[]; truncated: boolean }> {
  if (fileGlob) matchGlob(fileGlob, 'probe')
  const syntax = await session.exec(`grep -E -- ${shellQuote(pattern)} /dev/null`)
  if (syntax.code === 2) throw new Error('远程 grep 正则表达式无效')
  if (syntax.code !== 0 && syntax.code !== 1) throw new Error('服务器 grep 不可用')
  const fileList = await bounded(
    session,
    physicalScopeCommand(scope, "find . -type f ! -path '*/.*' -print0")
  )
  if (fileList.code !== 0 || fileList.stdoutTruncated)
    throw new Error('远程 find 文件范围过大或不可访问；请缩小路径')
  const candidates = nulPaths(fileList).paths.filter(
    (file) => !fileGlob || matchGlob(fileGlob, file.replace(/^\.\//, ''))
  )
  if (candidates.length > FALLBACK_FILE_LIMIT) throw new Error('远程 find 文件过多；请缩小路径')
  if (candidates.length === 0) return { matches: [], truncated: false }
  const grepScript = [
    'set -u',
    `cd -P -- ${shellQuote(scope.path)} || exit 72`,
    `root=${shellQuote(scope.canonicalRoot)}`,
    'if [ "$root" != / ]; then case "$PWD" in "$root"|"$root"/*) ;; *) exit 72 ;; esac; fi',
    `pattern=${shellQuote(pattern)}`,
    `for file in ${candidates.map(shellQuote).join(' ')}; do`,
    `  grep -nIhE ${caseSensitive ? '' : '-i'} -- "$pattern" "$file" | while IFS= read -r line; do printf '%s\\0%s\\0' "$file" "$line"; done`,
    '  status=${PIPESTATUS[0]}',
    '  [ "$status" -le 1 ] || exit 46',
    'done'
  ].join('\n')
  const output = await bounded(session, `bash -c ${shellQuote(grepScript)}`)
  if (output.code !== 0) throw new Error('远程 grep 搜索失败；请检查正则表达式或文件权限')
  return parseFallbackMatches(output, scope)
}

export async function remoteGrep(
  input: unknown,
  dependencies: RemoteWorkspaceBoundaryDependencies = {}
): Promise<RemoteGrepResult> {
  const request = requestRecord(input, [
    'sessionId',
    'projectId',
    'pattern',
    'path',
    'case',
    'gitignore',
    'skip'
  ])
  if (
    typeof request.pattern !== 'string' ||
    !request.pattern.trim() ||
    (request.path !== undefined && typeof request.path !== 'string') ||
    (request.case !== undefined && typeof request.case !== 'boolean') ||
    (request.gitignore !== undefined && typeof request.gitignore !== 'boolean') ||
    (request.skip !== undefined &&
      request.skip !== null &&
      (typeof request.skip !== 'number' || !Number.isInteger(request.skip) || request.skip < 0))
  )
    throw new Error('远程 grep 参数无效')
  const pathSpecs = ((request.path as string | undefined) || '.')
    .split(';')
    .map((path) => path.trim())
    .filter(Boolean)
  if (pathSpecs.length === 0 || pathSpecs.length > 8) throw new Error('远程 grep 路径数量无效')
  const parts: Array<{
    matches: RemoteGrepMatch[]
    truncated: boolean
    hostAlias: string
    engine: 'rg' | 'find-grep' | 'bounded-text'
  }> = []
  for (const rawPath of pathSpecs) {
    const { base, pattern: fileGlob } = scopeFromPath(rawPath)
    const part = await withAuthorizedRemoteWorkspacePath(
      { sessionId: request.sessionId, projectId: request.projectId, path: base, mode: 'existing' },
      async (authorized, session) => {
        const directory = (await session.exec(`test -d ${shellQuote(authorized.path)}`)).code === 0
        if (!directory && fileGlob) throw new Error('远程 grep 通配符基目录不是文件夹')
        if (!directory && !fileGlob) {
          const file = await readRemoteWorkspacePath(
            { sessionId: request.sessionId, projectId: request.projectId, path: authorized.path },
            dependencies
          )
          if (file.kind !== 'file') throw new Error('远程 grep 目标已不再是普通文件')
          let expression: RegExp
          try {
            expression = new RegExp(request.pattern as string, request.case === false ? 'i' : '')
          } catch {
            throw new Error('远程 grep 正则表达式无效')
          }
          const matches = file.content
            .split('\n')
            .flatMap((text, index) =>
              expression.test(text) ? [{ path: authorized.path, line: index + 1, text }] : []
            )
          return {
            matches,
            truncated: false,
            hostAlias: authorized.hostAlias,
            engine: 'bounded-text' as const
          }
        }
        const scope = directory
          ? authorized
          : { ...authorized, path: posix.dirname(authorized.path) }
        const effectiveGlob = fileGlob
        const rg = await hasRg(session)
        let found: { matches: RemoteGrepMatch[]; truncated: boolean }
        if (rg) {
          const command = physicalScopeCommand(
            scope,
            `rg --json --max-filesize 4M ${request.case === false ? '-i' : ''} ${request.gitignore === false ? '--no-ignore' : ''} ${effectiveGlob ? `-g ${shellQuote(effectiveGlob)} -g '!.*' -g '!**/.*'` : ''} -e ${shellQuote(request.pattern as string)} -- .`
          )
          const output = await bounded(session, command)
          if (output.code !== 0 && output.code !== 1)
            throw new Error('远程 rg 搜索失败；请检查正则表达式或目录权限')
          found = parseRgMatches(output, scope)
        } else {
          found = await fallbackGrep(
            session,
            scope,
            request.pattern as string,
            effectiveGlob,
            request.case !== false
          )
        }
        return {
          ...found,
          hostAlias: authorized.hostAlias,
          engine: rg ? ('rg' as const) : ('find-grep' as const)
        }
      },
      dependencies
    )
    parts.push(part)
  }
  const seen = new Set<string>()
  const matches = parts.flatMap((part) =>
    part.matches.filter((match) => {
      const key = `${match.path}\0${match.line}\0${match.text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  )
  const result = {
    matches,
    truncated: parts.some((part) => part.truncated),
    hostAlias: parts[0]?.hostAlias ?? '',
    engine: parts.every((part) => part.engine === parts[0]?.engine)
      ? (parts[0]?.engine ?? 'rg')
      : ('mixed' as const)
  }
  const grouped = new Map<string, RemoteGrepMatch[]>()
  const matchCounts = new Map<string, number>()
  for (const match of result.matches) {
    matchCounts.set(match.path, (matchCounts.get(match.path) ?? 0) + 1)
    const existing = grouped.get(match.path) ?? []
    if (existing.length < 20) existing.push(match)
    grouped.set(match.path, existing)
  }
  const files = [...grouped.keys()].sort()
  const skip = (request.skip as number | null | undefined) ?? 0
  const selectedFiles = files.slice(skip, skip + GREP_FILE_LIMIT)
  const selected = selectedFiles
    .flatMap((file) => grouped.get(file) ?? [])
    .slice(0, GREP_MATCH_LIMIT)
  const truncated =
    result.truncated ||
    files.length > skip + GREP_FILE_LIMIT ||
    [...matchCounts.values()].some((count) => count > 20)
  const content = selected.length
    ? selected
        .map((match) => `${remoteUri(result.hostAlias, match.path)}:${match.line}:${match.text}`)
        .join('\n')
    : '(no matches)'
  return {
    matches: selected.map((match) => ({ ...match, path: remoteUri(result.hostAlias, match.path) })),
    content: [
      content,
      ...(truncated ? ['[results truncated; use skip or narrow path]'] : []),
      ...(parts.some((part) => part.engine === 'find-grep') && request.gitignore !== false
        ? ['[gitignore not applied: rg unavailable]']
        : [])
    ].join('\n'),
    fileCount: selectedFiles.length,
    matchCount: selected.length,
    truncated,
    engine: result.engine,
    gitignoreApplied:
      parts.every((part) => part.engine !== 'find-grep') && request.gitignore !== false
  }
}
