import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getOfficialWebsitePluginDetail,
  validateOfficialWebsitePluginDetail
} from '../src/main/agent/packages/official-website-plugin-detail'

function payload(): Record<string, unknown> {
  return {
    kind: 'plugin',
    slug: 'demo-plugin',
    title: 'Demo plugin',
    description: 'A catalog plugin.',
    path: 'resources/plugins/demo-plugin',
    version: '1.2.3',
    source: 'Phi catalog',
    official: true,
    package: { raw: 'must not cross IPC' },
    agents: [{ name: 'DemoAgent', description: 'Agent description.', path: 'agents/Demo.md' }],
    skills: [{ name: 'demo-skill', description: 'Skill description.', path: 'skills/demo' }],
    scriptTools: [
      {
        name: 'demo_read',
        description: 'Read a result.',
        approval: 'read',
        skill: 'demo-skill',
        url: 'https://untrusted.example/tool'
      }
    ],
    environment: {
      id: 'phi:python@1',
      title: 'Python',
      description: 'Shared Python environment.',
      sharedNote: 'Shared runtime',
      usedBySkills: ['demo-skill'],
      usedByAgents: ['DemoAgent'],
      channels: ['conda-forge'],
      dependencies: [
        { name: 'python', version: '3.12', kind: 'conda', raw: { ignored: true } },
        { name: 'httpx', version: '0.28', kind: 'pip', note: 'pip' }
      ],
      yamlText: 'dependencies:\n  - python=3.12\n',
      sourceFile: 'resources/runtime/environments/phi-python/environment.yml',
      lookedFor: ['resources/plugins/demo-plugin/environment.yml']
    },
    packageUrl: 'https://untrusted.example/package',
    iconUrl: 'https://untrusted.example/icon.png'
  }
}

function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value))
}

test('website plugin detail validation keeps only the bounded renderer contract', () => {
  const detail = validateOfficialWebsitePluginDetail(bytes(payload()), 'demo-plugin')

  assert.deepEqual(detail, {
    id: 'demo-plugin',
    title: 'Demo plugin',
    summary: 'A catalog plugin.',
    version: '1.2.3',
    source: 'Phi catalog',
    official: true,
    agents: [{ name: 'DemoAgent', description: 'Agent description.' }],
    skills: [{ name: 'demo-skill', description: 'Skill description.' }],
    scriptTools: [
      {
        name: 'demo_read',
        description: 'Read a result.',
        approval: 'read',
        skillName: 'demo-skill'
      }
    ],
    environments: [
      {
        id: 'phi:python@1',
        title: 'Python',
        description: 'Shared Python environment.',
        sharedNote: 'Shared runtime',
        usedBySkills: ['demo-skill'],
        usedByAgents: ['DemoAgent'],
        channels: ['conda-forge'],
        dependencyManifest: {
          dependencies: [
            { name: 'python', version: '3.12', kind: 'conda' },
            { name: 'httpx', version: '0.28', kind: 'pip', note: 'pip' }
          ],
          yamlText: 'dependencies:\n  - python=3.12\n',
          sourceFile: 'resources/runtime/environments/phi-python/environment.yml',
          lookedFor: ['resources/plugins/demo-plugin/environment.yml']
        }
      }
    ]
  })
  assert.equal('packageUrl' in detail, false)
  assert.equal('path' in detail.agents[0], false)
  assert.equal('url' in detail.scriptTools[0], false)
})

test('an unfamiliar script tool approval or a missing owner skill keeps the rest of the detail', () => {
  const value = payload()
  value.scriptTools = [
    { name: 'demo_net', description: 'Calls out.', approval: 'network' },
    { name: 'demo_write', description: 'Writes.', approval: 'write', skill: 'demo-skill' }
  ]
  const detail = validateOfficialWebsitePluginDetail(bytes(value), 'demo-plugin')

  assert.deepEqual(detail.scriptTools, [
    { name: 'demo_net', description: 'Calls out.' },
    { name: 'demo_write', description: 'Writes.', approval: 'write', skillName: 'demo-skill' }
  ])
  assert.equal(detail.agents.length, 1)
})

test('website plugin detail validation caps strings and arrays', () => {
  const value = payload()
  value.title = 't'.repeat(1_000)
  value.agents = Array.from({ length: 300 }, (_, index) => ({
    name: `Agent${index}`,
    description: 'd'.repeat(20_000)
  }))
  ;(value.environment as Record<string, unknown>).dependencies = Array.from(
    { length: 2_100 },
    (_, index) => ({ name: `package-${index}`, kind: 'conda' })
  )

  const detail = validateOfficialWebsitePluginDetail(bytes(value), 'demo-plugin')

  assert.equal(detail.title.length, 160)
  assert.equal(detail.agents.length, 256)
  assert.equal(detail.agents[0].description.length, 8_000)
  assert.equal(detail.environments[0].dependencyManifest.dependencies.length, 2_048)
})

test('website plugin detail validation rejects wrong types, missing fields and id mismatch', () => {
  const wrongType = payload()
  wrongType.agents = 'not-an-array'
  assert.throws(
    () => validateOfficialWebsitePluginDetail(bytes(wrongType), 'demo-plugin'),
    /agents must be an array/
  )

  const missing = payload()
  delete missing.version
  assert.throws(
    () => validateOfficialWebsitePluginDetail(bytes(missing), 'demo-plugin'),
    /version must be a string/
  )

  assert.throws(
    () => validateOfficialWebsitePluginDetail(bytes(payload()), 'different-plugin'),
    /does not match/
  )
})

test('website plugin detail fetch returns unavailable for failures and oversized responses', async () => {
  const failed = await getOfficialWebsitePluginDetail('demo-plugin', {
    fetch: async () => new Response(null, { status: 503 }),
    timeoutMs: 50
  })
  assert.deepEqual(failed, { status: 'unavailable' })

  const oversized = await getOfficialWebsitePluginDetail('demo-plugin', {
    fetch: async () =>
      new Response('{}', { status: 200, headers: { 'content-length': String(2 * 1024 * 1024) } }),
    timeoutMs: 50
  })
  assert.deepEqual(oversized, { status: 'unavailable' })
})

test('website plugin detail fetch uses the derived endpoint and times out without network', async () => {
  let requestedUrl = ''
  const available = await getOfficialWebsitePluginDetail('demo-plugin', {
    fetch: async (input, init) => {
      requestedUrl = String(input)
      assert.equal(init?.redirect, 'error')
      return new Response(JSON.stringify(payload()), { status: 200 })
    },
    timeoutMs: 50
  })
  assert.equal(requestedUrl, 'https://phi.omicsagent.cn/api/plugins/demo-plugin')
  assert.equal(available.status, 'available')

  const timedOut = await getOfficialWebsitePluginDetail('demo-plugin', {
    fetch: async () => new Promise<Response>(() => {}),
    timeoutMs: 5
  })
  assert.deepEqual(timedOut, { status: 'unavailable' })
})
