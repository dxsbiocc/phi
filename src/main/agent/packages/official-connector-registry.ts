import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import type { LocalRegistry } from './installer-types'
import { errorMessage } from './installer-utils'
import { materializeRegistry } from './materialize-registry'
import { fetchOfficialConnectorPackages } from './official-connector-client'
import {
  officialConnectorRegistryDirectory,
  publishOfficialConnectorRegistry,
  readOfficialConnectorRegistry
} from './official-connector-cache'
import {
  OFFICIAL_REGISTRY_ID,
  syncOfficialRegistry,
  type OfficialRegistryOptions
} from './official-registry'
import { registryAssetPath, safeRegistryDirectory } from './registry-assets'

export {
  isOfficialConnectorRegistryDirectory,
  officialConnectorRegistryDirectory,
  readOfficialConnectorRegistry
} from './official-connector-cache'

const REFRESH_WINDOW_MS = 5 * 60_000
const refreshed = new Map<string, number>()
const synchronizations = new Map<string, Promise<LocalRegistry>>()

/** Build complete HTTP connector packages directly from the official API, without a GitHub source. */
export async function syncOfficialConnectorRegistry(
  options: OfficialRegistryOptions = {}
): Promise<LocalRegistry> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialConnectorRegistryDirectory(agentDir)
  const now = (options.now?.() ?? new Date()).getTime()
  const previous = refreshed.get(root)
  if (
    !options.forceRefresh &&
    previous !== undefined &&
    now >= previous &&
    now - previous < REFRESH_WINDOW_MS
  ) {
    try {
      return ready(
        readOfficialConnectorRegistry(root, { agentDir }),
        new Date(previous).toISOString()
      )
    } catch {
      /* Repair damaged managed contents from the API before use. */
    }
  }
  const pending = synchronizations.get(root)
  if (pending) return pending
  const task = synchronize({ ...options, agentDir })
    .then((registry) => {
      if (registry.label === 'Phi 官网' && registry.status === 'ready') refreshed.set(root, now)
      return registry
    })
    .finally(() => synchronizations.delete(root))
  synchronizations.set(root, task)
  return task
}

async function synchronize(options: OfficialRegistryOptions): Promise<LocalRegistry> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialConnectorRegistryDirectory(agentDir)
  let staging: string | undefined
  try {
    safeRegistryDirectory(agentDir, root, true)
    const payloads = await fetchOfficialConnectorPackages(options)
    staging = join(root, `staging-${randomUUID()}`)
    safeRegistryDirectory(root, staging, true)
    const packageDirs = payloads.map((payload) => {
      const directory = join(staging!, 'sources', payload.manifest.id)
      safeRegistryDirectory(staging!, directory, true)
      writeFileSync(registryAssetPath(directory, 'phi-package.yaml'), payload.yaml, { flag: 'wx' })
      if (payload.icon)
        writeFileSync(registryAssetPath(directory, payload.icon.name), payload.icon.bytes, {
          flag: 'wx'
        })
      return directory
    })
    const registry = materializeRegistry(packageDirs, join(staging, 'registry'), {
      id: OFFICIAL_REGISTRY_ID,
      trust: 'imported',
      generatedAt: new Date(0).toISOString()
    })
    const authBlocked = new Map(
      payloads.map((payload) => [payload.manifest.id, payload.directoryAuthBlocked])
    )
    registry.packages = registry.packages.map((entry) => ({
      ...entry,
      directoryAuthBlocked: authBlocked.get(entry.id)!
    }))
    const result = publishOfficialConnectorRegistry(registry, { agentDir })
    return ready(result, (options.now?.() ?? new Date()).toISOString())
  } catch (error) {
    const reason = errorMessage(error).slice(0, 500)
    try {
      const cached = readOfficialConnectorRegistry(root, { agentDir })
      return {
        ...cached,
        status: 'cached',
        notice: `The Phi Website Connector API is unavailable. Using the verified API cache (${reason}).`
      }
    } catch {
      const fallback = await syncOfficialRegistry(options)
      return {
        ...fallback,
        notice: `The Phi Website Connector API is unavailable. Using the signed release catalog (${reason}). ${fallback.notice ?? ''}`
      }
    }
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true })
  }
}

function ready(registry: LocalRegistry, refreshedAt: string): LocalRegistry {
  return { ...registry, status: 'ready', refreshedAt }
}
