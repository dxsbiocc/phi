import { readBoundedResponse } from './github-source'
import type { LocalRegistry } from './installer-types'
import { isRecord } from './installer-utils'
import { skillPackageIds } from './official-catalog-api'

interface SkillGroup {
  id: string
  label: string
  count: number
}

interface SkillAssignment {
  group: string
  groupLabel: string
  groupOrder: number
}

export interface OfficialSkillGroups {
  groups: SkillGroup[]
  assignments: Map<string, SkillAssignment>
}

/** Classification metadata only; endpoints and install sources never come from the API payload. */
export async function loadOfficialSkillGroups(
  catalog: unknown,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<OfficialSkillGroups | undefined> {
  if (!isRecord(catalog) || !Object.hasOwn(catalog, 'skillGroups')) return undefined
  if (!isRecord(catalog.counts) || !Number.isSafeInteger(catalog.counts.skills)) {
    throw new Error('Invalid Phi Website Skill group total')
  }
  const total = catalog.counts.skills as number
  if (total < 1 || total > 500) throw new Error('Phi Website Skill group total exceeds the limit')
  const groups = parseGroups(catalog.skillGroups)
  const all = groups.find((group) => group.id === 'all')
  const categories = groups.filter((group) => group.id !== 'all')
  if (
    !all ||
    all.count !== total ||
    categories.reduce((sum, group) => sum + group.count, 0) !== total
  ) {
    throw new Error('Phi Website Skill group count mismatch')
  }
  const byId = new Map(groups.map((group, order) => [group.id, { ...group, order }]))
  const assignments = new Map<string, SkillAssignment>()
  const counts = new Map(categories.map((group) => [group.id, 0]))
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  const pageCount = Math.ceil(total / 100)
  for (let page = 1; page <= pageCount; page += 1) {
    const value = await fetchPage(page, deadline, options.fetch ?? fetch)
    if (
      !isRecord(value) ||
      !Array.isArray(value.items) ||
      value.items.length !== Math.min(100, total - (page - 1) * 100) ||
      value.total !== total ||
      value.page !== page ||
      value.pageSize !== 100 ||
      value.pageCount !== pageCount ||
      !matchingPageGroups(value.groups, categories) ||
      (value.commit !== undefined && value.commit !== catalog.commit) ||
      (value.generatedAt !== undefined && value.generatedAt !== catalog.generatedAt)
    ) {
      throw new Error('Inconsistent Phi Website Skill group pagination or update timing')
    }
    for (const item of value.items) {
      if (!isRecord(item)) throw new Error('Invalid Phi Website Skill group entry')
      const ids = skillPackageIds(item)
      const group = typeof item.group === 'string' ? byId.get(item.group) : undefined
      if (ids.length !== 1 || !group || group.id === 'all' || item.groupLabel !== group.label) {
        throw new Error('Invalid Phi Website Skill group identifier or label')
      }
      const id = ids[0]
      if (assignments.has(id))
        throw new Error(`Phi Website Skill groups contain a duplicate Skill: ${id}`)
      assignments.set(id, { group: group.id, groupLabel: group.label, groupOrder: group.order })
      counts.set(group.id, (counts.get(group.id) ?? 0) + 1)
    }
  }
  if (
    assignments.size !== total ||
    categories.some((group) => counts.get(group.id) !== group.count)
  ) {
    throw new Error(
      'Phi Website Skill groups do not cover the complete catalog or have inconsistent counts'
    )
  }
  return { groups, assignments }
}

/** The website's declared groups override filesystem/category metadata without altering archives. */
export function applyOfficialSkillGroups(
  registry: LocalRegistry,
  groups: OfficialSkillGroups | undefined
): LocalRegistry {
  if (!groups) return registry
  const skills = registry.packages.filter((entry) => entry.type === 'skill')
  if (
    skills.length !== groups.assignments.size ||
    skills.some((entry) => !groups.assignments.has(entry.id))
  ) {
    throw new Error(
      'Phi Website Skill group identifiers do not match the pinned commit’s Skill catalog'
    )
  }
  const unchanged =
    JSON.stringify(registry.skillGroups) === JSON.stringify(groups.groups) &&
    skills.every((entry) => {
      const group = groups.assignments.get(entry.id)!
      return (
        entry.group === group.group &&
        entry.groupLabel === group.groupLabel &&
        entry.groupOrder === group.groupOrder &&
        entry.category === group.groupLabel
      )
    })
  if (unchanged) return registry
  return {
    ...registry,
    skillGroups: groups.groups,
    packages: registry.packages.map((entry) => {
      if (entry.type !== 'skill') return entry
      const group = groups.assignments.get(entry.id)!
      return { ...entry, ...group, category: group.groupLabel }
    })
  }
}

function parseGroups(value: unknown): SkillGroup[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error('Invalid Phi Website Skill group list')
  }
  const ids = new Set<string>()
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(item.id) ||
      typeof item.label !== 'string' ||
      !item.label.trim() ||
      item.label.length > 100 ||
      [...item.label].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      !Number.isSafeInteger(item.count) ||
      (item.count as number) < 0 ||
      (item.count as number) > 500 ||
      ids.has(item.id)
    ) {
      throw new Error('Invalid Phi Website Skill group ID, label, or count')
    }
    ids.add(item.id)
    return { id: item.id, label: item.label, count: item.count as number }
  })
}

function matchingPageGroups(value: unknown, categories: SkillGroup[]): boolean {
  const pageGroups = parseGroups(value)
  // The website list omits empty groups; the catalog still supplies them for navigation.
  const visibleIds = new Set(pageGroups.map((group) => group.id))
  const expected = categories.filter((group) => group.count > 0 || visibleIds.has(group.id))
  return JSON.stringify(pageGroups) === JSON.stringify(expected)
}

async function fetchPage(page: number, deadline: number, fetcher: typeof fetch): Promise<unknown> {
  const url = `https://phi.omicsagent.cn/api/skills?page=${page}&pageSize=100`
  const remaining = deadline - Date.now()
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 120_000)
    throw new Error('Invalid Phi Website Skill group request timeout')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let response: Response
  try {
    response = await Promise.race([
      fetcher(url, {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Phi Website Skill group request timed out'))
        }, remaining)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (!response.ok || (response.url && response.url !== url))
    throw new Error('Phi Website Skill group request failed or returned an invalid origin')
  const bytes = await readBoundedResponse(
    response,
    1024 * 1024,
    'Phi Website Skill groups',
    Math.max(1, deadline - Date.now())
  )
  return JSON.parse(bytes.toString('utf8')) as unknown
}
