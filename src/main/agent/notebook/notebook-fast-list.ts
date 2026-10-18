import { posix, resolve } from 'node:path'

import type { CommandResult, WorkspaceHost } from '../workspace-host/types'
import type { AnalysisNotebookSummary } from './analysis-notebooks'

const FAST_LIST_TIMEOUT_MS = 20_000
const FAST_LIST_MAX_OUTPUT_BYTES = 512 * 1024
const STAT_CONCURRENCY = 8
const INIT_MARKER = '#initialized'

export type FastNotebookList = {
  notebooks: AnalysisNotebookSummary[]
  truncated: boolean
  initialized: boolean
}

/**
 * Lists notebooks with ONE `find` on the host instead of one directory listing round trip per
 * directory (each is an SSH exec on pure-SSH hosts). Heavy directories are pruned, so large data
 * trees are never descended into. Returns undefined when the host cannot answer (no GNU
 * `find -printf`, timeout, odd output) so callers fall back to the portable walk. It never
 * starts Jupyter or any kernel.
 */
export async function listNotebooksWithFind(input: {
  host: WorkspaceHost
  projectCwd: string
  ignoredDirectories: ReadonlySet<string>
  maxDepth: number
  maxNotebooks: number
}): Promise<FastNotebookList | undefined> {
  const pruned = [...input.ignoredDirectories].flatMap((name, index) =>
    index === 0 ? ['-name', name] : ['-o', '-name', name]
  )
  const run = async (action: string): Promise<CommandResult | undefined> => {
    const script =
      `if [ -d notebooks ] && [ -d outputs ]; then echo '${INIT_MARKER}'; fi; ` +
      `depth="$1"; shift; exec find . -maxdepth "$depth" \\( -type d \\( "$@" \\) -prune \\) -o ` +
      `\\( -type f -iname '*.ipynb' ${action} \\)`
    try {
      return await input.host.exec.run(
        ['sh', '-c', script, 'phi-notebook-list', String(input.maxDepth + 1), ...pruned],
        {
          cwd: input.projectCwd,
          timeoutMs: FAST_LIST_TIMEOUT_MS,
          maxOutputBytes: FAST_LIST_MAX_OUTPUT_BYTES
        }
      )
    } catch {
      return undefined
    }
  }
  const timedOut = { notebooks: [], truncated: true, initialized: false }
  // GNU find reports size and mtime in one pass; other finds (BSD) fall back to bare paths.
  let result = await run("-printf '%p\\t%s\\t%T@\\n'")
  // A timed-out scan must not trigger the much slower per-directory walk.
  if (result?.terminationReason === 'timeout') return timedOut
  let withStat = true
  if (!result || result.code !== 0 || result.terminationReason) {
    result = await run('-print')
    if (result?.terminationReason === 'timeout') return timedOut
    if (!result || result.code !== 0 || result.terminationReason) return undefined
    withStat = false
  }
  const outputTruncated = result.stdoutTruncated === true || result.truncated === true
  const lines = result.stdout.split('\n')
  if (outputTruncated) lines.pop()
  let initialized = false
  const found: Array<{ relativePath: string; bytes?: number; modifiedAt?: string }> = []
  for (const line of lines) {
    if (!line) continue
    if (line === INIT_MARKER) {
      initialized = true
      continue
    }
    const parts = withStat ? line.split('\t') : [line]
    if (!parts[0].startsWith('./') || (withStat && parts.length !== 3)) return undefined
    const relativePath = posix.normalize(parts[0])
    if (!withStat) {
      found.push({ relativePath })
      continue
    }
    const size = Number(parts[1])
    const seconds = Number(parts[2])
    if (!Number.isFinite(size) || !Number.isFinite(seconds)) return undefined
    found.push({
      relativePath,
      bytes: size,
      modifiedAt: new Date(Math.round(seconds * 1000)).toISOString()
    })
  }
  const limited = found.slice(0, input.maxNotebooks)
  const notebooks = await mapLimited(limited, async (entry): Promise<AnalysisNotebookSummary> => {
    let { bytes, modifiedAt } = entry
    if (bytes === undefined || modifiedAt === undefined) {
      const stat = await input.host.fs.stat(entry.relativePath, { includeModifiedAt: true })
      bytes = stat.size
      modifiedAt = stat.modifiedAt ?? new Date(0).toISOString()
    }
    const directory = posix.dirname(entry.relativePath)
    return {
      path: resolve(input.projectCwd, entry.relativePath),
      relativePath: entry.relativePath,
      name: posix.basename(entry.relativePath),
      directory: directory === '.' ? '' : directory,
      bytes,
      modifiedAt
    }
  })
  return {
    notebooks,
    truncated: outputTruncated || found.length > input.maxNotebooks,
    initialized
  }
}

async function mapLimited<T, R>(items: readonly T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await map(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, items.length) }, worker))
  return results
}
