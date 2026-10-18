import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyOfficialSkillGroups,
  loadOfficialSkillGroups
} from '../src/main/agent/packages/official-skill-groups'
import type { LocalRegistry } from '../src/main/agent/packages/installer-types'

function fixture(total = 1): {
  catalog: {
    commit: string
    generatedAt: string
    counts: { skills: number }
    skillGroups: Array<{ id: string; label: string; count: number }>
    endpoints: { skills: string }
  }
  response: (page: number) => Record<string, unknown>
} {
  const catalog = {
    commit: 'a'.repeat(40),
    generatedAt: '2026-10-16T22:15:03.918Z',
    counts: { skills: total },
    skillGroups: [
      { id: 'all', label: 'All skills', count: total },
      { id: 'analysis', label: 'Scientific analysis', count: total },
      { id: 'empty', label: 'Empty group', count: 0 }
    ],
    endpoints: { skills: 'https://evil.example/execute' }
  }
  return {
    catalog,
    response: (page) => ({
      items: Array.from({ length: Math.min(100, total - (page - 1) * 100) }, (_, index) => ({
        id: `skill-${(page - 1) * 100 + index}`,
        group: 'analysis',
        groupLabel: 'Scientific analysis'
      })),
      groups: catalog.skillGroups.filter((group) => group.id !== 'all'),
      total,
      page,
      pageSize: 100,
      pageCount: Math.ceil(total / 100)
    })
  }
}

test('declared skill groups use bounded fixed-origin pagination and preserve empty groups and ordering', async () => {
  const f = fixture(201)
  const requests: string[] = []
  const groups = await loadOfficialSkillGroups(f.catalog, {
    fetch: async (input, init) => {
      const url = new URL(String(input))
      requests.push(url.href)
      assert.equal(url.origin, 'https://phi.omicsagent.cn')
      assert.equal(url.pathname, '/api/skills')
      assert.equal(url.searchParams.get('pageSize'), '100')
      assert.equal(init?.redirect, 'error')
      return Response.json(f.response(Number(url.searchParams.get('page'))))
    }
  })
  assert.equal(requests.length, 3)
  assert.equal(groups?.assignments.size, 201)
  assert.deepEqual(groups?.groups, f.catalog.skillGroups)
  assert.deepEqual(groups?.assignments.get('skill-200'), {
    group: 'analysis',
    groupLabel: 'Scientific analysis',
    groupOrder: 1
  })
})

test('legacy catalogs without a skillGroups declaration do not issue a classification request', async () => {
  assert.equal(
    await loadOfficialSkillGroups(
      { counts: { skills: 17 } },
      { fetch: async () => assert.fail('unexpected API request') }
    ),
    undefined
  )
})

test('the paginated API may omit empty groups while the catalog preserves them', async () => {
  const f = fixture()
  const groups = await loadOfficialSkillGroups(f.catalog, {
    fetch: async () =>
      Response.json({
        ...f.response(1),
        groups: f.catalog.skillGroups.filter((group) => group.id !== 'all' && group.count > 0)
      })
  })
  assert.equal(groups?.groups.at(-1)?.id, 'empty')
  assert.equal(groups?.groups.at(-1)?.count, 0)
})

test('classification overrides source categories without modifying package identity or archive hashes', async () => {
  const f = fixture()
  const groups = await loadOfficialSkillGroups(f.catalog, {
    fetch: async () => Response.json(f.response(1))
  })
  const registry: LocalRegistry = {
    id: 'phi-packages',
    dir: '/tmp/not-read',
    trust: 'imported',
    schemaVersion: 1,
    generatedAt: f.catalog.generatedAt,
    packages: [
      {
        id: 'skill-0',
        type: 'skill',
        version: '1.1.0',
        title: 'Skill',
        summary: 'Fixture',
        archive: 'skill-0.tar.gz',
        sha256: 'b'.repeat(64),
        size: 100,
        dependsOn: [],
        category: 'old filesystem category'
      }
    ]
  }
  const classified = applyOfficialSkillGroups(registry, groups)
  assert.equal(classified.packages[0].category, 'Scientific analysis')
  assert.equal(classified.packages[0].group, 'analysis')
  assert.equal(classified.packages[0].sha256, registry.packages[0].sha256)
  assert.equal(classified.packages[0].archive, registry.packages[0].archive)
  assert.equal(applyOfficialSkillGroups(classified, groups), classified)
  assert.throws(
    () =>
      applyOfficialSkillGroups(
        { ...registry, packages: [{ ...registry.packages[0], id: 'different-skill' }] },
        groups
      ),
    /pinned commit/
  )
})

test('invalid counts, duplicate groups, and oversized declarations fail before fetching any pages', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.catalog.skillGroups[1].count = 2
    },
    (f: ReturnType<typeof fixture>) => {
      f.catalog.skillGroups.push({ ...f.catalog.skillGroups[1] })
    },
    (f: ReturnType<typeof fixture>) => {
      f.catalog.counts.skills = 501
    },
    (f: ReturnType<typeof fixture>) => {
      f.catalog.skillGroups[1].label = 'bad\nlabel'
    },
    (f: ReturnType<typeof fixture>) => {
      f.catalog.skillGroups.splice(0, 1)
    }
  ]) {
    const f = fixture()
    mutate(f)
    await assert.rejects(
      loadOfficialSkillGroups(f.catalog, {
        fetch: async () => assert.fail('invalid catalog should not fetch')
      }),
      /Skill group/
    )
  }
})

test('incomplete, duplicate, mismatched, or temporally inconsistent API pages cannot replace cached metadata', async () => {
  for (const mutate of [
    (value: Record<string, unknown>) => {
      value.items = []
    },
    (value: Record<string, unknown>) => {
      value.page = 2
    },
    (value: Record<string, unknown>) => {
      value.total = 5
    },
    (value: Record<string, unknown>) => {
      value.groups = [{ id: 'analysis', label: 'Renamed during request', count: 1 }]
    },
    (value: Record<string, unknown>) => {
      value.items = [{ id: 'skill-0', group: 'unknown', groupLabel: 'Scientific analysis' }]
    },
    (value: Record<string, unknown>) => {
      value.items = [{ id: 'skill-0', group: 'analysis', groupLabel: 'Incorrect label' }]
    },
    (value: Record<string, unknown>) => {
      value.items = [{ id: '../unsafe', group: 'analysis', groupLabel: 'Scientific analysis' }]
    },
    (value: Record<string, unknown>) => {
      value.commit = 'b'.repeat(40)
    },
    (value: Record<string, unknown>) => {
      value.generatedAt = '2026-10-17T00:00:00Z'
    }
  ]) {
    const f = fixture()
    const value = f.response(1)
    mutate(value)
    await assert.rejects(
      loadOfficialSkillGroups(f.catalog, { fetch: async () => Response.json(value) }),
      /Skill group/
    )
  }
  const f = fixture(101)
  await assert.rejects(
    loadOfficialSkillGroups(f.catalog, {
      fetch: async (input) => {
        const page = Number(new URL(String(input)).searchParams.get('page'))
        const value = f.response(page)
        if (page === 2)
          value.items = [{ id: 'skill-0', group: 'analysis', groupLabel: 'Scientific analysis' }]
        return Response.json(value)
      }
    }),
    /duplicate Skill/
  )
})

test('classification API failures, oversized responses, and ignored cancellation are bounded', async () => {
  const f = fixture()
  for (const response of [
    new Response(null, { status: 503 }),
    new Response(' '.repeat(1024 * 1024 + 1)),
    new Response('invalid json')
  ]) {
    await assert.rejects(loadOfficialSkillGroups(f.catalog, { fetch: async () => response }))
  }
  await assert.rejects(
    loadOfficialSkillGroups(f.catalog, {
      timeoutMs: 5,
      fetch: async () => new Promise<Response>(() => {})
    }),
    /timed out/
  )
})
