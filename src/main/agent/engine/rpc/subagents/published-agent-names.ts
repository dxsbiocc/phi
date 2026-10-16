import { createHash } from 'node:crypto'

import type { PhiAgentDefinition } from '../../../agents/definition'
import { snapshotBinding, snapshotDefinition } from './definition-validation'
import type { RpcAgentServerBinding } from './types'

const publishedNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u

export interface RpcPublishedAgentName {
  readonly sourceName: string
  readonly displayName: string
  readonly defaultName: string
  readonly nativeName: string
  readonly blocking: boolean
}

function checkedPublishedName(value: unknown): string {
  if (typeof value !== 'string' || !publishedNamePattern.test(value)) {
    throw new Error('Invalid published RPC agent name')
  }
  return value
}

/**
 * Production names are opaque as before, but their namespace excludes model
 * selection so the exact names are knowable immediately after connection.
 */
export function planRpcPublishedAgentNames(
  definitions: readonly PhiAgentDefinition[],
  binding: RpcAgentServerBinding,
  aliases: Readonly<Record<string, string>> = {}
): readonly RpcPublishedAgentName[] {
  const agents = definitions
    .map(snapshotDefinition)
    .sort((left, right) => left.name.localeCompare(right.name))
  const stableBinding = snapshotBinding(binding)
  const namespace = createHash('sha256')
    .update(JSON.stringify({ binding: stableBinding, definitions: agents }))
    .digest('hex')
    .slice(0, 24)
  const defaults = agents.flatMap((agent, index) =>
    (
      [
        { agent, blocking: true, defaultName: `phi_${namespace}_${index}_fg` },
        { agent, blocking: false, defaultName: `phi_${namespace}_${index}_bg` }
      ] as const
    ).map((entry) => ({ ...entry, defaultName: checkedPublishedName(entry.defaultName) }))
  )
  const planned = defaults.map((entry) => {
    const alias = aliases[entry.agent.name]
    const nativeName = checkedPublishedName(
      alias ? (entry.blocking ? alias : `${alias}-background`) : entry.defaultName
    )
    return Object.freeze({
      sourceName: entry.agent.name,
      displayName: alias ?? entry.agent.name,
      defaultName: entry.defaultName,
      nativeName,
      blocking: entry.blocking
    })
  })
  const names = planned.map((entry) => entry.nativeName)
  if (new Set(names).size !== names.length) throw new Error('Duplicate published RPC agent name')
  return Object.freeze(planned)
}

export function nextRpcAgentAlias(sourceName: string, occupiedNames: ReadonlySet<string>): string {
  const base = checkedPublishedName(`${checkedPublishedName(sourceName)}-phi`)
  for (let suffix = 1; suffix <= 10_000; suffix++) {
    const candidate = suffix === 1 ? base : checkedPublishedName(`${base}-${suffix}`)
    const background = checkedPublishedName(`${candidate}-background`)
    if (!occupiedNames.has(candidate) && !occupiedNames.has(background)) return candidate
  }
  throw new Error('No available Phi agent alias')
}

export function nextProjectAgentName(name: string, occupiedNames: ReadonlySet<string>): string {
  const base = checkedPublishedName(`${checkedPublishedName(name)}-project`)
  for (let suffix = 1; suffix <= 10_000; suffix++) {
    const candidate = suffix === 1 ? base : checkedPublishedName(`${base}-${suffix}`)
    if (!occupiedNames.has(candidate)) return candidate
  }
  throw new Error('No available project agent name')
}
