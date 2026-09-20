/**
 * Progress for a running wrapper, derived from Nextflow's own console output.
 * Two log shapes are understood: Nextflow 26 (`[PROCESS ab/123456] NAME (tag)`)
 * and the classic `[ab/123456] Submitted process > NAME (tag)`. `started` counts
 * distinct process names seen so far and `total` is the number of distinct
 * process nodes in the wrapper's pre-generated DAG (`wrapper/dag.mmd`), so
 * "3 of 6" means three of the six steps have begun — an estimate, not a
 * completion percentage: Nextflow does not print task completion here.
 */

import type { WrapperRunProgress } from '../types'

export type RunProgress = WrapperRunProgress

const PROCESS_NODE = /^\s*v\d+\(\["([^"]+)"\]\)\s*$/
const PROCESS_LINES = [
  /^\[PROCESS\s+[0-9a-f]{2}\/[0-9a-f]+\]\s+(\S+)/,
  /^\[[0-9a-f]{2}\/[0-9a-f]{6}\]\s+(?:Submitted|Cached)\s+process\s+>\s+(\S+)/
]
const DEFAULT_MAX_LINES = 40
const DEFAULT_TAIL_CHARS = 4000

/** Distinct process nodes in a Nextflow `-with-dag` Mermaid export, or undefined when there are none. */
export function countDagProcesses(dag: string | undefined): number | undefined {
  if (!dag) return undefined
  const names = new Set<string>()
  for (const line of dag.split('\n')) {
    const match = PROCESS_NODE.exec(line)
    if (match) names.add(match[1])
  }
  return names.size > 0 ? names.size : undefined
}

function simpleProcessName(qualified: string): string {
  const segments = qualified.split(':')
  return segments[segments.length - 1]
}

export interface ProgressTracker {
  push(chunk: string): void
  snapshot(): RunProgress
  /** The newest output, at most `maxChars` characters (default 4000). */
  tail(maxChars?: number): string
}

export function createProgressTracker(
  options: { total?: number; maxLines?: number } = {}
): ProgressTracker {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const seen = new Set<string>()
  let current: string | undefined
  let lines: string[] = []
  let partial = ''

  const consume = (line: string): void => {
    lines.push(line)
    if (lines.length > maxLines) lines = lines.slice(-maxLines)
    for (const pattern of PROCESS_LINES) {
      const match = pattern.exec(line)
      if (!match) continue
      current = simpleProcessName(match[1])
      seen.add(current)
      return
    }
  }

  return {
    push(chunk: string): void {
      const pieces = (partial + chunk).split('\n')
      partial = pieces.pop() ?? ''
      for (const piece of pieces) consume(piece)
    },
    snapshot(): RunProgress {
      return {
        started: seen.size,
        ...(options.total !== undefined ? { total: options.total } : {}),
        ...(current !== undefined ? { current } : {})
      }
    },
    tail(maxChars: number = DEFAULT_TAIL_CHARS): string {
      const text = [...lines, ...(partial ? [partial] : [])].join('\n')
      return text.length > maxChars ? text.slice(-maxChars) : text
    }
  }
}
