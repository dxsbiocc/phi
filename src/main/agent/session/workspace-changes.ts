import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  MAX_WORKSPACE_CHANGE_FILES,
  MAX_WORKSPACE_DIFF_BYTES,
  type WorkspaceChangeSummary,
  type WorkspaceFileChange,
  type WorkspaceDiffReference
} from '../../../shared/workspaceChangeTypes'

const MAX_PATHS = 1000
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_BASELINE_BYTES = 16 * 1024 * 1024
const MAX_CAPTURE_MS = 5000
const GIT_TIMEOUT_MS = 5000
const GIT_OUTPUT_BYTES = 2 * 1024 * 1024

type FileSnapshot =
  | { kind: 'missing' }
  | { kind: 'file'; bytes: Buffer }
  | { kind: 'large'; size: number; mtimeMs?: number }
  | { kind: 'link'; target: string }
  | { kind: 'other'; size: number; mtimeMs: number }

export type WorkspaceChangeBaseline = {
  root: string
  scopeRoot: string
  head: string | null
  before: Map<string, FileSnapshot>
}

function gitText(cwd: string, args: string[], allowDifference = false): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', ...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: GIT_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
      },
      (error, stdout) => {
        if (error && !(allowDifference && String((error as { code?: unknown }).code) === '1')) {
          reject(error)
        } else {
          resolveResult(stdout)
        }
      }
    )
  })
}

function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', ...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: MAX_TEXT_BYTES + 1,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolveResult(stdout)
      }
    )
  })
}

function names(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

function insideRoot(root: string, path: string): boolean {
  const inside = relative(root, path)
  return inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))
}

function absoluteGitPath(root: string, scopeRoot: string, name: string): string | null {
  const path = resolve(root, name)
  return insideRoot(root, path) && insideRoot(scopeRoot, path) ? path : null
}

async function changedTrackedPaths(root: string, head: string | null): Promise<string[]> {
  if (!head) return names(await gitText(root, ['ls-files', '-z']))
  return names(
    await gitText(root, [
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      head,
      '--'
    ])
  )
}

async function untrackedPaths(root: string): Promise<string[]> {
  return names(await gitText(root, ['ls-files', '--others', '--exclude-standard', '-z']))
}

async function readSnapshot(path: string, budget: { remaining: number }): Promise<FileSnapshot> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return { kind: 'link', target: await readlink(path) }
    if (!info.isFile()) return { kind: 'other', size: info.size, mtimeMs: info.mtimeMs }
    if (info.size > MAX_TEXT_BYTES || info.size > budget.remaining) {
      return { kind: 'large', size: info.size, mtimeMs: info.mtimeMs }
    }
    const bytes = await readFile(path)
    if (bytes.length > MAX_TEXT_BYTES || bytes.length > budget.remaining) {
      return { kind: 'large', size: bytes.length, mtimeMs: info.mtimeMs }
    }
    budget.remaining -= bytes.length
    return { kind: 'file', bytes }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
}

async function readHeadSnapshot(
  root: string,
  head: string | null,
  name: string
): Promise<FileSnapshot> {
  if (!head) return { kind: 'missing' }
  try {
    const bytes = await gitBytes(root, ['show', `${head}:${name}`])
    return bytes.length > MAX_TEXT_BYTES
      ? { kind: 'large', size: bytes.length }
      : { kind: 'file', bytes }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { kind: 'large', size: MAX_TEXT_BYTES + 1 }
    }
    // A path added after the run began does not exist in the starting commit.
    if (String(code) === '128') return { kind: 'missing' }
    throw error
  }
}

function sameSnapshot(before: FileSnapshot, after: FileSnapshot): boolean {
  if (before.kind !== after.kind) return false
  if (before.kind === 'missing') return true
  if (before.kind === 'file' && after.kind === 'file') return before.bytes.equals(after.bytes)
  if (before.kind === 'link' && after.kind === 'link') return before.target === after.target
  if (before.kind === 'large' && after.kind === 'large') {
    return (
      before.mtimeMs !== undefined && before.size === after.size && before.mtimeMs === after.mtimeMs
    )
  }
  if (before.kind === 'other' && after.kind === 'other') {
    return before.size === after.size && before.mtimeMs === after.mtimeMs
  }
  return false
}

function textBytes(snapshot: FileSnapshot): Buffer | null {
  if (snapshot.kind === 'missing') return Buffer.alloc(0)
  if (snapshot.kind !== 'file' || snapshot.bytes.includes(0)) return null
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)
    return snapshot.bytes
  } catch {
    return null
  }
}

async function lineCounts(
  root: string,
  before: FileSnapshot,
  after: FileSnapshot,
  scratch: string
): Promise<{ added: number; deleted: number } | null> {
  const oldBytes = textBytes(before)
  const newBytes = textBytes(after)
  if (!oldBytes || !newBytes) return null
  const beforePath = join(scratch, 'before')
  const afterPath = join(scratch, 'after')
  await Promise.all([writeFile(beforePath, oldBytes), writeFile(afterPath, newBytes)])
  try {
    const output = await gitText(
      root,
      ['diff', '--no-index', '--numstat', '--no-ext-diff', '--', beforePath, afterPath],
      true
    )
    const match = /^(\d+)\t(\d+)\t/.exec(output)
    return match ? { added: Number(match[1]), deleted: Number(match[2]) } : null
  } catch {
    return null
  }
}

async function unifiedDiff(root: string, scratch: string): Promise<string | null> {
  try {
    const output = await gitText(
      root,
      [
        'diff',
        '--no-index',
        '--no-color',
        '--no-ext-diff',
        '--unified=3',
        '--',
        join(scratch, 'before'),
        join(scratch, 'after')
      ],
      true
    )
    const firstHunk = output.search(/^@@ /m)
    if (firstHunk < 0) return null
    const patch = output.slice(firstHunk)
    return Buffer.byteLength(patch, 'utf8') <= MAX_WORKSPACE_DIFF_BYTES ? patch : null
  } catch {
    return null
  }
}

export async function beginWorkspaceChangeCapture(
  cwd: string
): Promise<WorkspaceChangeBaseline | null> {
  try {
    const startedAt = Date.now()
    const root = await realpath((await gitText(cwd, ['rev-parse', '--show-toplevel'])).trim())
    const scopeRoot = await realpath(cwd)
    const head = await gitText(root, ['rev-parse', '--verify', 'HEAD']).then(
      (value) => value.trim(),
      () => null
    )
    const [tracked, untracked] = await Promise.all([
      changedTrackedPaths(root, head),
      untrackedPaths(root)
    ])
    const paths = [...new Set([...tracked, ...untracked])].filter((name) =>
      absoluteGitPath(root, scopeRoot, name)
    )
    if (paths.length > MAX_PATHS) return null
    const before = new Map<string, FileSnapshot>()
    const budget = { remaining: MAX_BASELINE_BYTES }
    for (const name of paths) {
      if (Date.now() - startedAt > MAX_CAPTURE_MS) return null
      const path = absoluteGitPath(root, scopeRoot, name)
      if (path) before.set(name, await readSnapshot(path, budget))
    }
    return { root, scopeRoot, head, before }
  } catch {
    return null
  }
}

export async function finishWorkspaceChangeCapture(
  baseline: WorkspaceChangeBaseline | null,
  options: {
    onTextDiff?: (name: string, patch: string) => Promise<WorkspaceDiffReference | null>
  } = {}
): Promise<WorkspaceChangeSummary | null> {
  if (!baseline) return null
  try {
    const startedAt = Date.now()
    const { root, scopeRoot, head, before } = baseline
    const [tracked, untracked] = await Promise.all([
      changedTrackedPaths(root, head),
      untrackedPaths(root)
    ])
    const candidateNames = [...new Set([...before.keys(), ...tracked, ...untracked])]
      .filter((name) => absoluteGitPath(root, scopeRoot, name))
      .sort()
    let scanned = 0
    const budget = { remaining: MAX_BASELINE_BYTES }
    const files: WorkspaceFileChange[] = []
    const scratch = await mkdtemp(join(tmpdir(), 'phi-workspace-changes-'))
    try {
      for (const name of candidateNames.slice(0, MAX_PATHS)) {
        if (Date.now() - startedAt > MAX_CAPTURE_MS) break
        scanned += 1
        const path = absoluteGitPath(root, scopeRoot, name)
        if (!path) continue
        const oldState = before.get(name) ?? (await readHeadSnapshot(root, head, name))
        const newState = await readSnapshot(path, budget)
        if (sameSnapshot(oldState, newState)) continue
        const counts = await lineCounts(root, oldState, newState, scratch)
        let diff: WorkspaceDiffReference | null = null
        if (counts && options.onTextDiff) {
          const patch = await unifiedDiff(root, scratch)
          if (patch) {
            try {
              diff = await options.onTextDiff(name, patch)
            } catch {
              // A failed artifact write must not hide the file-change summary.
            }
          }
        }
        files.push({
          path,
          displayPath: name,
          status:
            oldState.kind === 'missing'
              ? 'added'
              : newState.kind === 'missing'
                ? 'deleted'
                : 'modified',
          added: counts?.added ?? null,
          deleted: counts?.deleted ?? null,
          ...(diff ? { diff } : {})
        })
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
    if (files.length === 0 && scanned < candidateNames.length) return null
    return {
      files: files.slice(0, MAX_WORKSPACE_CHANGE_FILES),
      totalChanged: files.length,
      truncated: scanned < candidateNames.length || files.length > MAX_WORKSPACE_CHANGE_FILES
    }
  } catch {
    return null
  }
}
