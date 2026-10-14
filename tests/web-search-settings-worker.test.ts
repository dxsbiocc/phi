import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createInProcessFixture } from './engine-contract/in-process-factory'
import { parse as parseYaml } from 'yaml'

import { OmpBridge } from '../src/main/agent/engine/omp-bridge'
import type { WebSearchSettings } from '../src/shared/webSearchSettingsTypes'

test(
  'OMP worker persists selected search engines and SearXNG settings',
  { timeout: 20000 },
  async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'phi-web-search-'))
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    writeFileSync(join(agentDir, 'config.yml'), 'providers:\n  fetch: native\n')
    const bridge = new OmpBridge()

    try {
      const initial = await bridge.request<WebSearchSettings>('settings.webSearch.get', {
        agentDir
      })
      assert.ok(initial.providers.length > 20)
      const initialBrave = initial.providers.find((provider) => provider.id === 'brave')
      assert.equal(initialBrave?.apiKeyStored, false)
      await assert.rejects(
        bridge.request('settings.webSearch.searxngEngines', { agentDir }),
        /保存 SearXNG 实例地址/
      )

      const patch = {
        orderedEnabledIds: ['searxng', 'exa'],
        searxngEndpoint: 'http://127.0.0.1:8888',
        searxngEngines: 'sogou wechat'
      }
      const saved = await bridge.request<WebSearchSettings>('settings.webSearch.update', {
        agentDir,
        patch
      })
      assert.deepEqual(saved.orderedEnabledIds, patch.orderedEnabledIds)
      assert.equal(saved.searxngEndpoint, patch.searxngEndpoint)
      assert.equal(saved.searxngEngines, patch.searxngEngines)

      const config = parseYaml(readFileSync(join(agentDir, 'config.yml'), 'utf8')) as {
        providers: { fetch: string; webSearchOrder?: string[]; webSearchExclude?: string[] }
        modelRoles: { web: string }
        retry: { fallbackChains: { web: string[] } }
        phi: { webSearch: { order: string[]; excluded: string[] } }
        searxng: { endpoint: string; engines: string }
      }
      assert.deepEqual(config.phi.webSearch.order, ['searxng'])
      assert.equal(config.modelRoles.web, 'web/searxng')
      assert.deepEqual(config.retry.fallbackChains.web, ['web/exa'])
      assert.equal(config.providers.webSearchOrder, undefined)
      assert.equal(config.providers.fetch, 'native')
      assert.ok(config.phi.webSearch.excluded.includes('google'))
      assert.equal(config.providers.webSearchExclude, undefined)
      assert.equal(config.searxng.endpoint, patch.searxngEndpoint)
      assert.equal(config.searxng.engines, patch.searxngEngines)

      await assert.rejects(
        bridge.request('settings.webSearch.apiKey.set', {
          agentDir,
          providerId: 'google',
          key: 'not-allowed'
        }),
        /不接受 API Key/
      )
      await bridge.request('settings.webSearch.apiKey.set', {
        agentDir,
        providerId: 'brave',
        key: 'test-brave-secret'
      })
      const withKey = await bridge.request<WebSearchSettings>('settings.webSearch.get', {
        agentDir
      })
      assert.equal(
        withKey.providers.find((provider) => provider.id === 'brave')?.apiKeyConfigured,
        true
      )
      assert.equal(
        withKey.providers.find((provider) => provider.id === 'brave')?.apiKeyStored,
        true
      )
      assert.doesNotMatch(JSON.stringify(withKey), /test-brave-secret/)
      assert.doesNotMatch(readFileSync(join(agentDir, 'config.yml'), 'utf8'), /test-brave-secret/)
      await bridge.request('settings.webSearch.apiKey.clear', { agentDir, providerId: 'brave' })
      const withoutKey = await bridge.request<WebSearchSettings>('settings.webSearch.get', {
        agentDir
      })
      assert.equal(
        withoutKey.providers.find((provider) => provider.id === 'brave')?.apiKeyConfigured,
        initialBrave?.apiKeyConfigured
      )
      assert.equal(
        withoutKey.providers.find((provider) => provider.id === 'brave')?.apiKeyStored,
        false
      )
    } finally {
      await bridge.stop()
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
      rmSync(agentDir, { recursive: true, force: true })
    }
  }
)

test(
  'search settings update reaches the native web tool of an existing session',
  { timeout: 20000 },
  async () => {
    const f = await createInProcessFixture()
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          results: [
            {
              title: 'Contract search evidence',
              url: 'https://example.invalid/contract',
              content: 'Disposable loopback search result'
            }
          ]
        })
      )
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      await f.engine.sessions.create({
        sessionId: 'web-contract',
        cwd: f.cwd,
        agentDir: f.agentDir,
        model: f.model,
        sessionManager: { kind: 'memory', cwd: f.cwd },
        resourceOptions: {
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          noPromptTemplates: true,
          noThemes: true
        },
        autoCompaction: { enabled: false },
        enableToolApproval: false
      })
      await f.engine.settings.webSearch.update({
        agentDir: f.agentDir,
        patch: {
          orderedEnabledIds: ['searxng'],
          searxngEndpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          searxngEngines: ''
        }
      })
      f.provider.enqueue(
        { tool: { name: 'web_search', args: { query: 'contract search evidence' } } },
        { text: 'Search configuration reached the live session.' }
      )
      await f.engine.sessions.prompt({
        sessionId: 'web-contract',
        text: 'Search the disposable fixture.'
      })
      assert.equal(requests.length, 1)
      assert.match(requests[0], /q=contract/)
      assert.ok(
        f.provider.requests
          .at(-1)
          ?.messages.some(
            (message) =>
              message.role === 'tool' &&
              String(message.content).includes('Contract search evidence')
          )
      )
    } finally {
      await f.close()
      server.closeAllConnections()
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
    }
  }
)
