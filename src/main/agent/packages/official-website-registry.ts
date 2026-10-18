import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import { fetchGithubSnapshot, readBoundedResponse } from './github-source'
import type { LocalRegistry } from './installer-types'
import { errorMessage, isRecord } from './installer-utils'
import { syncOfficialRegistry, type OfficialRegistryOptions } from './official-registry'
import {
  OFFICIAL_WEBSITE_REPOSITORY,
  OFFICIAL_WEBSITE_MATERIALIZER_REVISION,
  cloneOfficialWebsiteRegistry,
  officialWebsiteRegistryDirectory,
  publishOfficialWebsiteRegistry,
  readOfficialWebsiteMaterializerRevision,
  readOfficialWebsiteRegistry
} from './official-website-cache'
import { materializeOfficialWebsite } from './official-website-materialize'
import { safeRegistryDirectory } from './registry-assets'
import {
  applyOfficialSkillGroups,
  loadOfficialSkillGroups,
  type OfficialSkillGroups
} from './official-skill-groups'

export {
  isOfficialWebsiteRegistryDirectory,
  officialWebsiteRegistryDirectory,
  readOfficialWebsiteRegistry
} from './official-website-cache'

const WEBSITE_CATALOG_URL = 'https://phi.omicsagent.cn/api/catalog'
const REFRESH_WINDOW_MS = 5 * 60_000
const refreshes = new Map<string, number>()
const synchronizations = new Map<string, Promise<LocalRegistry>>()

interface WebsiteCatalog {
  commit: string
  generatedAt: string
  skillCount: number
  skillGroups?: OfficialSkillGroups
}

/** Prefer the website's fixed official repository snapshot; retain the signed release as fallback. */
export async function syncPreferredOfficialRegistry(
  options: OfficialRegistryOptions = {}
): Promise<LocalRegistry> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialWebsiteRegistryDirectory(agentDir)
  const now = (options.now?.() ?? new Date()).getTime()
  const refreshedAt = refreshes.get(root)
  if (
    !options.forceRefresh &&
    refreshedAt !== undefined &&
    now >= refreshedAt &&
    now - refreshedAt < REFRESH_WINDOW_MS
  ) {
    try {
      const cached = readOfficialWebsiteRegistry(root, { agentDir })
      if (
        readOfficialWebsiteMaterializerRevision(cached) === OFFICIAL_WEBSITE_MATERIALIZER_REVISION
      ) {
        return {
          ...cached,
          status: 'ready',
          refreshedAt: new Date(refreshedAt).toISOString()
        }
      }
    } catch {
      // A damaged cache must be repaired from source, never silently reused.
    }
  }
  const pending = synchronizations.get(root)
  if (pending) return pending
  const synchronization = synchronizeWebsite({ ...options, agentDir })
    .then((registry) => {
      if (registry.status === 'ready' && registry.label === 'Phi 官网') refreshes.set(root, now)
      return registry
    })
    .finally(() => synchronizations.delete(root))
  synchronizations.set(root, synchronization)
  return synchronization
}

async function synchronizeWebsite(options: OfficialRegistryOptions): Promise<LocalRegistry> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialWebsiteRegistryDirectory(agentDir)
  let staging: string | undefined
  try {
    safeRegistryDirectory(agentDir, root, true)
    const catalog = await fetchWebsiteCatalog(options)
    let cached: LocalRegistry | undefined
    try {
      cached = readOfficialWebsiteRegistry(root, { agentDir })
    } catch {
      // Missing, outdated, or invalid generations are rebuilt from a bounded pinned snapshot.
    }
    if (
      cached?.source?.sha === catalog.commit &&
      readOfficialWebsiteMaterializerRevision(cached) === OFFICIAL_WEBSITE_MATERIALIZER_REVISION
    ) {
      const metadata =
        cached.generatedAt === catalog.generatedAt
          ? cached
          : { ...cached, generatedAt: catalog.generatedAt }
      const updated = applyOfficialSkillGroups(metadata, catalog.skillGroups)
      if (updated === cached) return ready(cached, options)
      staging = join(root, `staging-${randomUUID()}`)
      safeRegistryDirectory(root, staging, true)
      const cloned = cloneOfficialWebsiteRegistry(updated, staging)
      return ready(
        publishOfficialWebsiteRegistry(cloned, catalog.commit, { agentDir, notice: cached.notice }),
        options
      )
    }
    const snapshotsRoot = join(root, 'snapshots')
    const snapshotRoot = join(
      snapshotsRoot,
      OFFICIAL_WEBSITE_REPOSITORY.owner,
      OFFICIAL_WEBSITE_REPOSITORY.name,
      catalog.commit
    )
    safeRegistryDirectory(root, snapshotRoot, true)
    const snapshotStagingRoot = join(snapshotsRoot, '.staging')
    safeRegistryDirectory(root, snapshotStagingRoot, true)
    const sourceDir = await fetchGithubSnapshot(OFFICIAL_WEBSITE_REPOSITORY, catalog.commit, {
      cacheRoot: snapshotsRoot,
      tmpDir: snapshotStagingRoot,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs ?? 120_000,
      force: true,
      limits: {
        maxCompressedBytes: 64 * 1024 * 1024,
        maxExpandedBytes: 256 * 1024 * 1024,
        maxEntries: 20_000,
        maxDepth: 16
      }
    })
    safeRegistryDirectory(root, sourceDir)
    staging = join(root, `staging-${randomUUID()}`)
    safeRegistryDirectory(root, staging, true)
    const built = materializeOfficialWebsite({
      sourceDir,
      stagingDir: staging,
      generatedAt: catalog.generatedAt,
      expectedSkillCount: catalog.skillCount
    })
    const notice = built.notices.length
      ? `${built.notices.length} resources in the Phi Website catalog are unavailable: ${built.notices.join('; ')}`.slice(
          0,
          1900
        )
      : undefined
    const classified = applyOfficialSkillGroups(built.registry, catalog.skillGroups)
    const verified = publishOfficialWebsiteRegistry(classified, catalog.commit, {
      agentDir,
      notice
    })
    return ready(verified, options)
  } catch (error) {
    const reason = errorMessage(error).slice(0, 500)
    try {
      const cached = readOfficialWebsiteRegistry(root, { agentDir })
      return {
        ...cached,
        status: 'cached',
        notice: `The Phi Website update is unavailable. Using the verified website cache (${reason}). ${cached.notice ?? ''}`
      }
    } catch {
      const fallback = await syncOfficialRegistry(options)
      return {
        ...fallback,
        notice: `The Phi Website content is unavailable. Using the signed release catalog (${reason}). ${fallback.notice ?? ''}`
      }
    }
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true })
  }
}

function ready(registry: LocalRegistry, options: OfficialRegistryOptions): LocalRegistry {
  return {
    ...registry,
    status: 'ready',
    refreshedAt: (options.now?.() ?? new Date()).toISOString()
  }
}

async function fetchWebsiteCatalog(options: OfficialRegistryOptions): Promise<WebsiteCatalog> {
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error('Invalid Phi Website catalog request timeout')
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let response: Response
  try {
    response = await Promise.race([
      (options.fetch ?? fetch)(WEBSITE_CATALOG_URL, {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Phi Website catalog request timed out'))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (!response.ok) throw new Error(`Phi Website catalog request failed (HTTP ${response.status})`)
  if (response.url && response.url !== WEBSITE_CATALOG_URL)
    throw new Error('Invalid Phi Website catalog response origin')
  const bytes = await readBoundedResponse(response, 256 * 1024, 'Phi Website catalog', timeoutMs)
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (
    !isRecord(value) ||
    typeof value.commit !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(value.commit) ||
    typeof value.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    !isRecord(value.counts) ||
    !Number.isSafeInteger(value.counts.skills) ||
    (value.counts.skills as number) < 1 ||
    (value.counts.skills as number) > 500
  ) {
    throw new Error('Invalid Phi Website catalog commit or Skill count')
  }
  return {
    commit: value.commit.toLowerCase(),
    generatedAt: value.generatedAt,
    skillCount: value.counts.skills as number,
    skillGroups: await loadOfficialSkillGroups(value, options)
  }
}
