import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'

import { OmpBridge } from '../src/main/agent/omp/omp-bridge'
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
        providers: { fetch: string; webSearchOrder: string[]; webSearchExclude: string[] }
        searxng: { endpoint: string; engines: string }
      }
      assert.deepEqual(config.providers.webSearchOrder, ['searxng'])
      assert.equal(config.providers.fetch, 'native')
      assert.ok(config.providers.webSearchExclude.includes('google'))
      assert.equal(config.searxng.endpoint, patch.searxngEndpoint)
      assert.equal(config.searxng.engines, patch.searxngEngines)
    } finally {
      await bridge.stop()
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
      rmSync(agentDir, { recursive: true, force: true })
    }
  }
)
