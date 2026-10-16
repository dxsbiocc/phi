import type { PhiAgentDefinition } from '../../../agents/definition'
import type { RemoteSshSession } from '../../../wrappers/remote-ssh-session'
import type { AgentNameConflictNotice } from '../../../../../shared/agentNameConflictTypes'
import type { RpcAgentServerBinding } from './types'
import {
  detectNearestOmpAgentDefinitions,
  rpcAgentConflictIdentity,
  type DetectedRpcAgentDefinition
} from './agent-conflict-remote'
import {
  nextProjectAgentName,
  nextRpcAgentAlias,
  planRpcPublishedAgentNames,
  type RpcPublishedAgentName
} from './published-agent-names'

export interface RpcAgentConflictDeferral {
  readonly filePath: string
  readonly contentHash: string
  readonly name: string
}

export interface RpcAgentConflictRecord {
  readonly notice: AgentNameConflictNotice
  readonly detection: DetectedRpcAgentDefinition
  readonly profile: RpcPublishedAgentName
}

export interface RpcAgentConflictScan {
  readonly publication: readonly RpcPublishedAgentName[]
  readonly conflicts: readonly RpcAgentConflictRecord[]
  /** Native profile name -> refusal reason for a session-scoped "Not now". */
  readonly blocked: Readonly<
    Record<string, { readonly filePath: string; readonly contentHash: string }>
  >
  readonly occupiedNames: ReadonlySet<string>
  readonly verificationError?: string
}

/** Mirrors OMP's sorted first-definition-wins merge inside the nearest directory. */
function firstDefinitions(
  detections: readonly DetectedRpcAgentDefinition[]
): readonly DetectedRpcAgentDefinition[] {
  const names = new Set<string>()
  return detections.filter((detection) => {
    if (names.has(detection.name)) return false
    names.add(detection.name)
    return true
  })
}

export async function scanRpcAgentConflicts(options: {
  readonly session: RemoteSshSession
  readonly sessionId: string
  readonly projectId: string
  readonly hostAlias: string
  readonly projectRoot: string
  readonly binding: RpcAgentServerBinding
  readonly definitions: readonly PhiAgentDefinition[]
  readonly aliases?: Readonly<Record<string, string>>
  readonly deferrals?: Readonly<Record<string, RpcAgentConflictDeferral>>
}): Promise<RpcAgentConflictScan> {
  const publication = planRpcPublishedAgentNames(
    options.definitions,
    options.binding,
    options.aliases
  )
  let allDefinitions: readonly DetectedRpcAgentDefinition[]
  try {
    allDefinitions = firstDefinitions(
      await detectNearestOmpAgentDefinitions(options.session, options.projectRoot, [])
    )
  } catch (error) {
    const filePath = `${options.projectRoot}/.omp/agents`
    return Object.freeze({
      publication,
      conflicts: Object.freeze([]),
      blocked: Object.freeze(
        Object.fromEntries(
          publication.map((profile) => [
            profile.nativeName,
            { filePath, contentHash: '0'.repeat(64) }
          ])
        )
      ),
      occupiedNames: new Set(publication.map((profile) => profile.nativeName)),
      verificationError: error instanceof Error ? error.message : String(error)
    })
  }
  const occupiedNames = new Set([
    ...allDefinitions.map((definition) => definition.name),
    ...publication.map((profile) => profile.nativeName),
    ...Object.values(options.aliases ?? {})
  ])
  const profileByName = new Map(publication.map((profile) => [profile.nativeName, profile]))
  const blocked: Record<string, { filePath: string; contentHash: string }> = {}
  const conflicts: RpcAgentConflictRecord[] = []
  for (const detection of allDefinitions) {
    const profile = profileByName.get(detection.name)
    if (!profile) continue
    const deferral = options.deferrals?.[profile.sourceName]
    if (deferral) {
      for (const related of publication.filter(
        (entry) => entry.sourceName === profile.sourceName
      )) {
        blocked[related.nativeName] = {
          filePath: detection.filePath,
          contentHash: detection.contentHash
        }
      }
      continue
    }
    const notice: AgentNameConflictNotice = Object.freeze({
      id: rpcAgentConflictIdentity(options.projectId, options.sessionId, detection),
      sessionId: options.sessionId,
      projectId: options.projectId,
      hostAlias: options.hostAlias,
      filePath: detection.filePath,
      phiAgentName: profile.sourceName,
      requestedName: detection.name,
      proposedPhiName: nextRpcAgentAlias(profile.sourceName, occupiedNames),
      proposedOtherName: nextProjectAgentName(detection.name, occupiedNames)
    })
    conflicts.push(Object.freeze({ notice, detection, profile }))
  }
  return Object.freeze({
    publication,
    conflicts: Object.freeze(conflicts),
    blocked: Object.freeze(blocked),
    occupiedNames
  })
}
