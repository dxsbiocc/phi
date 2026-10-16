import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import { discoverAgents, getAgent } from '@oh-my-pi/pi-coding-agent/task'
import { parseAgent } from '@oh-my-pi/pi-coding-agent/task/agents'

/**
 * Resolve through OMP's execution-time discovery and compare the selected
 * record, its source, and its parsed/raw content with Phi's attested artifact.
 */
export async function rpcTaskDefinitionConflictReason(
  session: AgentSession,
  input: { readonly name: string; readonly expectedPath: string; readonly expectedHash: string }
): Promise<string | undefined> {
  let resolvedLocation = 'an unresolved OMP agent definition'
  try {
    const discovery = await discoverAgents(
      session.sessionManager.getCwd(),
      undefined,
      session.effectiveExtensionRoots
    )
    const resolved = getAgent(discovery.agents, input.name)
    resolvedLocation = resolved?.filePath ?? resolvedLocation
    if (!resolved) return `Phi child ${input.name} is shadowed by ${resolvedLocation}`
    const [expectedRealPath, resolvedRealPath, content] = await Promise.all([
      realpath(input.expectedPath),
      resolved.filePath ? realpath(resolved.filePath) : Promise.resolve(''),
      readFile(input.expectedPath)
    ])
    const published = parseAgent(input.expectedPath, content.toString('utf8'), 'user')
    return expectedRealPath === input.expectedPath &&
      resolved.source === 'user' &&
      resolved.filePath === input.expectedPath &&
      resolvedRealPath === expectedRealPath &&
      createHash('sha256').update(content).digest('hex') === input.expectedHash &&
      isDeepStrictEqual(resolved, published)
      ? undefined
      : `Phi child ${input.name} is shadowed by ${resolvedLocation}`
  } catch {
    return `Phi child ${input.name} cannot verify OMP's resolved definition at ${resolvedLocation}`
  }
}
