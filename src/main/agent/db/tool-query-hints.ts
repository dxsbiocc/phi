import { closestNames } from '../name-match'
import type { DbConnectorCatalogEntry } from './manifest-types'

export { closestNames }

/**
 * Turns a rejected db_query into an answer the model can act on: what was wrong, and the few
 * real names it probably meant. Only ever applied to a call that already failed.
 */

/** How many names to show when nothing is close, so the model still sees what exists. */
const MAX_FALLBACK_NAMES = 8

function nameList(names: readonly string[]): string {
  return names.join(', ')
}

export function unknownDatabaseMessage(
  database: string,
  catalog: readonly DbConnectorCatalogEntry[]
): string {
  const ids = catalog.map((entry) => entry.manifest.id)
  const close = closestNames(database, ids)
  const suggestion = close.length > 0 ? `最接近: ${nameList(close)}。` : ''
  return `未找到数据库连接器: ${database}。${suggestion}不确定用哪个时先用 db_search 查找。`
}

export function unknownDomainMessage(entry: DbConnectorCatalogEntry, domain: string): string {
  const ids = entry.manifest.domains.map((candidate) => candidate.id)
  const close = closestNames(domain, ids)
  const shown = close.length > 0 ? close : ids.slice(0, MAX_FALLBACK_NAMES)
  return `数据库 ${entry.manifest.id} 没有 domain "${domain}"。${
    close.length > 0 ? '最接近' : '例如'
  }: ${nameList(shown)}（共 ${ids.length} 个）。用 db_domain 查看某个 domain 的字段。`
}

const NAME_ERRORS: Array<{ pattern: RegExp; listLabel: string; what: string }> = [
  {
    pattern: /^(.*does not expose field: (.+?));\s*available fields: (.*)$/s,
    listLabel: 'available fields',
    what: 'fields'
  },
  {
    pattern: /^(.*does not accept filter: (.+?));\s*accepted filters: (.*)$/s,
    listLabel: 'accepted filters',
    what: 'filters'
  }
]

/**
 * Adapters reject an unknown field or filter with the complete list of valid ones, which for a
 * large domain is most of a page. Replaces that list with the names closest to what was asked.
 * Any other message is returned as it came.
 */
export function enrichDbQueryErrorMessage(message: string): string {
  for (const { pattern, what } of NAME_ERRORS) {
    const match = pattern.exec(message)
    if (!match) continue
    const [, head, wrong, list] = match
    const valid = list
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    const close = closestNames(wrong.trim(), valid)
    const shown = close.length > 0 ? close : valid.slice(0, MAX_FALLBACK_NAMES)
    return `${head}. Did you mean: ${nameList(shown)}? (${valid.length} ${what} available; db_domain lists them.)`
  }
  return message
}
