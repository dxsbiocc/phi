import assert from 'node:assert/strict'
import test from 'node:test'

import {
  listSearxngEngines,
  normalizeWebSearchSettingsPatch,
  webSearchSettingsFromValues
} from '../src/main/agent/web-search-settings'

test('web search defaults expose OMP providers in their native order', () => {
  const settings = webSearchSettingsFromValues({
    order: [],
    excluded: [],
    endpoint: undefined,
    engines: undefined
  })

  assert.equal(settings.providers.length, 23)
  assert.deepEqual(
    settings.orderedEnabledIds,
    settings.providers.map((provider) => provider.id)
  )
  assert.equal(settings.searxngEndpoint, '')
})

test('web search selection restores priority and excludes disabled providers', () => {
  const settings = webSearchSettingsFromValues({
    order: ['searxng', 'exa'],
    excluded: ['google', 'searxng'],
    endpoint: 'http://127.0.0.1:8888',
    engines: 'sogou wechat'
  })

  assert.equal(settings.orderedEnabledIds[0], 'exa')
  assert.ok(!settings.orderedEnabledIds.includes('google'))
  assert.ok(!settings.orderedEnabledIds.includes('searxng'))
  assert.equal(settings.searxngEngines, 'sogou wechat')
})

test('default selection persists as empty order and exclude lists', () => {
  const settings = webSearchSettingsFromValues({
    order: [],
    excluded: [],
    endpoint: undefined,
    engines: undefined
  })
  const normalized = normalizeWebSearchSettingsPatch({
    orderedEnabledIds: settings.orderedEnabledIds,
    searxngEndpoint: '',
    searxngEngines: ''
  })

  assert.deepEqual(normalized.order, [])
  assert.deepEqual(normalized.excluded, [])
})

test('reordering writes only the necessary priority prefix', () => {
  const settings = webSearchSettingsFromValues({
    order: [],
    excluded: [],
    endpoint: undefined,
    engines: undefined
  })
  const reordered = [
    'searxng',
    ...settings.orderedEnabledIds.filter((id) => id !== 'searxng' && id !== 'google')
  ]
  const normalized = normalizeWebSearchSettingsPatch({
    orderedEnabledIds: reordered,
    searxngEndpoint: 'http://127.0.0.1:8888/',
    searxngEngines: ' sogou wechat, duckduckgo '
  })

  assert.deepEqual(normalized.order, ['searxng'])
  assert.deepEqual(normalized.excluded, ['google'])
  assert.equal(normalized.endpoint, 'http://127.0.0.1:8888')
  assert.equal(normalized.engines, 'sogou wechat,duckduckgo')
})

test('web search rejects invalid provider sets and SearXNG addresses', () => {
  const patch = {
    orderedEnabledIds: ['searxng'],
    searxngEndpoint: 'http://127.0.0.1:8888',
    searxngEngines: ''
  }

  assert.throws(() => normalizeWebSearchSettingsPatch({ ...patch, orderedEnabledIds: [] }))
  assert.throws(() =>
    normalizeWebSearchSettingsPatch({ ...patch, orderedEnabledIds: ['searxng', 'searxng'] })
  )
  assert.throws(() =>
    normalizeWebSearchSettingsPatch({ ...patch, orderedEnabledIds: ['not-a-provider'] })
  )
  assert.throws(() =>
    normalizeWebSearchSettingsPatch({ ...patch, searxngEndpoint: 'file:///tmp/search' })
  )
  assert.throws(() =>
    normalizeWebSearchSettingsPatch({
      ...patch,
      searxngEndpoint: 'https://user:secret@example.com'
    })
  )
})

test('SearXNG engine choices come from the configured instance, not OMP providers', async () => {
  let requestedUrl = ''
  const engines = await listSearxngEngines({ endpoint: 'http://127.0.0.1:8888/' }, (async (
    input
  ) => {
    requestedUrl = String(input)
    return Response.json({
      engines: [
        { name: 'sogou', shortcut: 'sogou', categories: ['general'], enabled: false },
        { name: 'sogou wechat', shortcut: 'sogouw', categories: ['news'], enabled: true },
        { name: 'bitbucket', categories: ['it'], enabled: false },
        { name: 'sogou wechat', enabled: true },
        { enabled: true }
      ]
    })
  }) as typeof fetch)

  assert.equal(requestedUrl, 'http://127.0.0.1:8888/config')
  assert.deepEqual(engines, [
    { name: 'sogou', shortcut: 'sogou', categories: ['general'], enabled: false },
    { name: 'sogou wechat', shortcut: 'sogouw', categories: ['news'], enabled: true },
    { name: 'bitbucket', categories: ['it'], enabled: false }
  ])
  assert.ok(!engines.some((engine) => engine.name === 'xai'))
})

test('SearXNG engine lookup rejects missing endpoints and invalid config responses', async () => {
  await assert.rejects(listSearxngEngines({ endpoint: '' }), /实例地址/)
  await assert.rejects(
    listSearxngEngines(
      { endpoint: 'https://search.example' },
      (async () => new Response('forbidden', { status: 403 })) as typeof fetch
    ),
    /HTTP 403/
  )
  await assert.rejects(
    listSearxngEngines({ endpoint: 'https://search.example' }, (async () =>
      Response.json({ noEngines: true })) as typeof fetch),
    /未提供引擎列表/
  )
})
