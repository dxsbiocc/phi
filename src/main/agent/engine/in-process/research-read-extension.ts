import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { isPathInsideRoot } from '../../local-file-access'
import { isRecord } from '../../../../shared/guards'
import type { AgentRunRegistry } from '../../agents/registry'
import { authoredUserText } from '../tool-adapter'

const TABLE_OR_LOG = /\.(?:tsv|csv|tab|jsonl|ndjson|log|stderr|stdout)(?:\.gz)?$/i

function delegationCallsSinceUser(branch: readonly unknown[]): Set<string> {
  const ids = new Set<string>()
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]
    if (!isRecord(entry) || entry.type !== 'message' || !isRecord(entry.message)) continue
    const message = entry.message
    if (authoredUserText(message) !== undefined) break
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string')
      ids.add(message.toolCallId)
  }
  return ids
}

function localPath(cwd: string, reference: string): string | undefined {
  try {
    let path = reference
    if (/^file:/i.test(path)) {
      const url = new URL(path)
      if (url.host && url.host !== 'localhost') return undefined
      path = fileURLToPath(url)
    }
    if (/^(?:\/\/|\\\\)/.test(path)) return undefined
    if (!isAbsolute(path) && /^[a-z][a-z\d+.-]*:/i.test(path)) return undefined
    const absolute = resolve(cwd, path)
    return isPathInsideRoot(cwd, absolute) || isPathInsideRoot(realpathSync(cwd), absolute)
      ? absolute
      : undefined
  } catch {
    return undefined
  }
}

function canonical(cwd: string, reference: string): string | undefined {
  const path = localPath(cwd, reference)
  if (!path) return undefined
  try {
    const actual = realpathSync(path)
    return isPathInsideRoot(realpathSync(cwd), actual) ? actual : undefined
  } catch {
    return path
  }
}

function wholeReadPaths(cwd: string, value: string): Set<string | undefined> {
  // Native read prefers literal filenames before inline selectors and multi-path recovery.
  const path = value.trim()
  const literal = localPath(cwd, path)
  if (literal && existsSync(literal)) return new Set([canonical(cwd, path)])
  // Commas between range chunks are selectors on one file, not separate requests.
  const parts = path.split(/;|,(?!\s*L?\d+(?:(?:[-+]|\.\.)L?\d*)?\s*(?:,|:raw|;|$))/i)
  const references = [path, ...parts, ...parts.flatMap((part) => part.split(/\s+/))]
  // A lone :1 (also :L1, :1-, :1..) reads from line one to EOF in OMP.
  const wholeSelector = /:(?:raw(?::L?0*1(?:-|\.\.)?)?|L?0*1(?:-|\.\.)?(?::raw)?)$/i
  return new Set(references.map((ref) => canonical(cwd, ref.trim().replace(wholeSelector, ''))))
}

export function researchReadNotice(
  cwd: string,
  requested: string,
  branch: readonly unknown[],
  registry: Pick<AgentRunRegistry, 'researchFindings'>
): string | undefined {
  const calls = delegationCallsSinceUser(branch)
  if (!calls.size) return undefined
  const findings = registry.researchFindings(calls)
  if (findings.length === 0) return undefined
  const reads = wholeReadPaths(cwd, requested)
  for (const finding of findings) {
    for (const reference of finding.evidence) {
      if (!TABLE_OR_LOG.test(reference)) continue
      const path = canonical(cwd, reference)
      if (!path || !reads.has(path)) continue
      return [
        `The specialist already reported this artifact: ${reference}.`,
        finding.answer,
        finding.interpretation,
        'Use the finding for delivery and link the artifact with present_files. If the question needs a particular value, request a focused inspection from the specialist or use a specific line range.'
      ].join(' ')
    }
  }
  return undefined
}

/** Intercepts before native read streams any bytes or the session journal records its tool result. */
export function createResearchReadExtension(registry: AgentRunRegistry): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', (event, ctx) => {
      if (
        event.toolName !== 'read' ||
        ctx.agent.kind !== 'main' ||
        typeof event.input.path !== 'string'
      )
        return
      const reason = researchReadNotice(
        ctx.cwd,
        event.input.path,
        ctx.sessionManager.getBranch(),
        registry
      )
      return reason ? { block: true, reason } : undefined
    })
  }
}
