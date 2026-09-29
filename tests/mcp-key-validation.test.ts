import assert from 'node:assert/strict'
import test from 'node:test'
import {
  McpApiKeyValidationError,
  validateFeaturedMcpApiKey
} from '../src/main/agent/mcp-key-validation'

const responses: Record<string, unknown> = {
  tavily: { key: { usage: 0 }, account: { current_plan: 'free' } },
  serpapi: { account_id: 'account-1', api_key: 'secret-test-key' },
  firecrawl: { success: true, data: { remainingCredits: 0 } },
  'browser-use': { projectId: 'project-1', totalCreditsBalanceUsd: 0 }
}

test('API-key validation reads provider accounts without starting paid tools', async () => {
  for (const id of Object.keys(responses)) {
    let requestedUrl = ''
    let requestedOptions: RequestInit | undefined
    await validateFeaturedMcpApiKey(id, 'secret-test-key', (async (url, options) => {
      requestedUrl = String(url)
      requestedOptions = options
      return new Response(JSON.stringify(responses[id]), { status: 200 })
    }) as typeof fetch)
    assert.equal(requestedOptions?.method, 'GET')
    assert.equal(requestedOptions?.redirect, 'error')
    assert.equal(requestedOptions?.cache, 'no-store')
    const headers = requestedOptions?.headers as Record<string, string>
    if (id === 'serpapi') {
      assert.equal(new URL(requestedUrl).searchParams.get('api_key'), 'secret-test-key')
    } else {
      assert.equal(requestedUrl.includes('secret-test-key'), false)
      assert.equal(
        id === 'browser-use' ? headers['X-Browser-Use-API-Key'] : headers.Authorization,
        id === 'browser-use' ? 'secret-test-key' : 'Bearer secret-test-key'
      )
    }
  }
})

test('invalid keys are distinct from temporary verification failures and never echoed', async () => {
  const secret = 'secret-test-key'
  await assert.rejects(
    validateFeaturedMcpApiKey(
      'tavily',
      secret,
      (async () => new Response('{}', { status: 401 })) as typeof fetch
    ),
    (error: unknown) =>
      error instanceof McpApiKeyValidationError &&
      error.kind === 'invalid' &&
      !error.message.includes(secret)
  )
  await assert.rejects(
    validateFeaturedMcpApiKey('serpapi', secret, (async () => {
      throw new Error(`request failed for ${secret}`)
    }) as typeof fetch),
    (error: unknown) =>
      error instanceof McpApiKeyValidationError &&
      error.kind === 'unavailable' &&
      !error.message.includes(secret)
  )
  await assert.rejects(
    validateFeaturedMcpApiKey(
      'firecrawl',
      secret,
      (async () => new Response('{}', { status: 200 })) as typeof fetch
    ),
    (error: unknown) => error instanceof McpApiKeyValidationError && error.kind === 'unavailable'
  )
  await assert.rejects(
    validateFeaturedMcpApiKey(
      'browser-use',
      secret,
      (async () => new Response('{}', { status: 429 })) as typeof fetch
    ),
    (error: unknown) => error instanceof McpApiKeyValidationError && error.kind === 'unavailable'
  )
})
