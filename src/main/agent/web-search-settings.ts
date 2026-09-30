import {
  SEARCH_PROVIDER_CHOICES,
  type SearchProviderId
} from '@oh-my-pi/pi-coding-agent/web/search/types'
import type {
  SearxngEngineOption,
  WebSearchSettings,
  WebSearchSettingsPatch
} from '../../shared/webSearchSettingsTypes'

const PROVIDER_IDS = SEARCH_PROVIDER_CHOICES.map((provider) => provider.value)
const PROVIDER_ID_SET = new Set<string>(PROVIDER_IDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function knownIds(value: unknown): SearchProviderId[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.filter((id): id is SearchProviderId => {
    if (typeof id !== 'string' || !PROVIDER_ID_SET.has(id) || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export function webSearchSettingsFromValues(values: {
  order: unknown
  excluded: unknown
  endpoint: unknown
  engines: unknown
}): WebSearchSettings {
  const excluded = new Set(knownIds(values.excluded))
  const preferred = knownIds(values.order).filter((id) => !excluded.has(id))
  const orderedEnabledIds = [
    ...preferred,
    ...PROVIDER_IDS.filter((id) => !excluded.has(id) && !preferred.includes(id))
  ]
  return {
    providers: SEARCH_PROVIDER_CHOICES.map(({ value, label, description }) => ({
      id: value,
      label,
      description
    })),
    orderedEnabledIds,
    searxngEndpoint: typeof values.endpoint === 'string' ? values.endpoint : '',
    searxngEngines: typeof values.engines === 'string' ? values.engines : ''
  }
}

export function normalizeWebSearchSettingsPatch(value: unknown): {
  order: SearchProviderId[]
  excluded: SearchProviderId[]
  endpoint: string | undefined
  engines: string | undefined
} {
  if (!isRecord(value) || !Array.isArray(value.orderedEnabledIds)) {
    throw new Error('网页搜索设置格式无效')
  }
  const ids = value.orderedEnabledIds
  if (
    ids.length === 0 ||
    ids.length > PROVIDER_IDS.length ||
    ids.some((id) => typeof id !== 'string' || !PROVIDER_ID_SET.has(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error('请选择至少一个有效的搜索服务')
  }
  if (typeof value.searxngEndpoint !== 'string' || typeof value.searxngEngines !== 'string') {
    throw new Error('SearXNG 设置格式无效')
  }

  const endpoint = value.searxngEndpoint.trim().replace(/\/+$/, '')
  if (endpoint) {
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      throw new Error('请输入有效的 SearXNG 实例地址')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      endpoint.length > 2048
    ) {
      throw new Error('SearXNG 地址须为不含凭据或参数的 HTTP(S) 根地址')
    }
  }
  const engines = value.searxngEngines
    .split(',')
    .map((engine) => engine.trim())
    .filter(Boolean)
    .join(',')
  if (engines.length > 512) throw new Error('SearXNG 内部引擎列表过长')

  const enabled = ids as SearchProviderId[]
  const enabledSet = new Set<string>(enabled)
  const excluded = PROVIDER_IDS.filter((id) => !enabledSet.has(id))
  const defaultEnabled = PROVIDER_IDS.filter((id) => enabledSet.has(id))
  let order = enabled
  for (let length = 0; length <= enabled.length; length++) {
    const prefix = enabled.slice(0, length)
    const remainder = defaultEnabled.filter((id) => !prefix.includes(id))
    if ([...prefix, ...remainder].every((id, index) => id === enabled[index])) {
      order = prefix
      break
    }
  }

  return {
    order,
    excluded,
    endpoint: endpoint || undefined,
    engines: engines || undefined
  }
}

export type { WebSearchSettingsPatch }

export async function listSearxngEngines(
  config: {
    endpoint: unknown
    token?: unknown
    basicUsername?: unknown
    basicPassword?: unknown
  },
  fetchImpl: typeof fetch = fetch
): Promise<SearxngEngineOption[]> {
  if (typeof config.endpoint !== 'string' || !config.endpoint.trim()) {
    throw new Error('请先保存 SearXNG 实例地址')
  }
  const endpoint = config.endpoint.trim().replace(/\/+$/, '')
  let base: URL
  try {
    base = new URL(endpoint)
  } catch {
    throw new Error('SearXNG 实例地址无效')
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('SearXNG 实例地址无效')
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (typeof config.basicUsername === 'string' || typeof config.basicPassword === 'string') {
    if (typeof config.basicUsername !== 'string' || typeof config.basicPassword !== 'string') {
      throw new Error('SearXNG Basic 认证需同时配置用户名和密码')
    }
    headers.Authorization = `Basic ${Buffer.from(`${config.basicUsername}:${config.basicPassword}`, 'utf8').toString('base64')}`
  } else if (typeof config.token === 'string' && config.token) {
    headers.Authorization = `Bearer ${config.token}`
  }

  const response = await fetchImpl(`${endpoint}/config`, {
    headers,
    signal: AbortSignal.timeout(8000)
  })
  if (!response.ok) throw new Error(`读取 SearXNG 引擎失败（HTTP ${response.status}）`)
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > 2_000_000) throw new Error('SearXNG 引擎列表过大')
  const body = await response.text()
  if (body.length > 2_000_000) throw new Error('SearXNG 引擎列表过大')
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('SearXNG /config 未返回有效 JSON')
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.engines)) {
    throw new Error('SearXNG /config 未提供引擎列表')
  }

  const seen = new Set<string>()
  return parsed.engines.flatMap((entry): SearxngEngineOption[] => {
    if (!isRecord(entry) || typeof entry.name !== 'string') return []
    const name = entry.name.trim()
    if (!name || seen.has(name.toLowerCase())) return []
    seen.add(name.toLowerCase())
    return [
      {
        name,
        ...(typeof entry.shortcut === 'string' ? { shortcut: entry.shortcut } : {}),
        categories: Array.isArray(entry.categories)
          ? entry.categories.filter((value): value is string => typeof value === 'string')
          : [],
        enabled: entry.enabled === true
      }
    ]
  })
}
