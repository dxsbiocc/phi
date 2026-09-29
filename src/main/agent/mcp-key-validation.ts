import { apiKeyConnector } from './mcp-key-credentials'

export class McpApiKeyValidationError extends Error {
  constructor(
    readonly kind: 'invalid' | 'unavailable',
    message: string
  ) {
    super(message)
    this.name = 'McpApiKeyValidationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validAccountResponse(id: string, body: unknown): boolean {
  if (!isRecord(body)) return false
  switch (id) {
    case 'tavily':
      return isRecord(body.key) && isRecord(body.account)
    case 'serpapi':
      return typeof body.account_id === 'string' && body.account_id.length > 0
    case 'firecrawl':
      return body.success === true && isRecord(body.data)
    case 'browser-use':
      return typeof body.projectId === 'string' && body.projectId.length > 0
    default:
      return false
  }
}

/** Check an account endpoint before saving a key; no search, crawl, or browser task runs. */
export async function validateFeaturedMcpApiKey(
  id: string,
  key: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  apiKeyConnector(id)
  if (typeof key !== 'string' || !key.trim() || /[\r\n\0]/.test(key)) {
    throw new McpApiKeyValidationError('invalid', 'API key 格式无效')
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  let url: string
  switch (id) {
    case 'tavily':
      url = 'https://api.tavily.com/usage'
      headers.Authorization = `Bearer ${key.trim()}`
      break
    case 'serpapi': {
      const accountUrl = new URL('https://serpapi.com/account.json')
      accountUrl.searchParams.set('api_key', key.trim())
      url = accountUrl.toString()
      break
    }
    case 'firecrawl':
      url = 'https://api.firecrawl.dev/v2/team/credit-usage'
      headers.Authorization = `Bearer ${key.trim()}`
      break
    case 'browser-use':
      url = 'https://api.browser-use.com/api/v2/billing/account'
      headers['X-Browser-Use-API-Key'] = key.trim()
      break
    default:
      throw new McpApiKeyValidationError('invalid', '不支持此连接器')
  }

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })
  } catch {
    // Fetch errors can contain the full URL, including SerpApi's query-string key.
    throw new McpApiKeyValidationError('unavailable', '暂时无法连接服务商验证 API key，请稍后重试')
  }

  if (response.status === 401 || response.status === 403) {
    throw new McpApiKeyValidationError('invalid', 'API key 无效或没有访问权限')
  }
  if (!response.ok) {
    throw new McpApiKeyValidationError('unavailable', '服务商暂时无法验证 API key，请稍后重试')
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new McpApiKeyValidationError('unavailable', '服务商返回了无法识别的验证结果')
  }
  if (!validAccountResponse(id, body)) {
    throw new McpApiKeyValidationError('unavailable', '服务商返回了无法识别的验证结果')
  }
}
