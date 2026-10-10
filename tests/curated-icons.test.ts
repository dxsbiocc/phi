import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveCuratedResourceIcon } from '../src/main/agent/curated-icons'
import { readResourceIcon } from '../src/main/agent/resource-icons'
import { RESOURCE_ICON_MAX_BYTES } from '../src/shared/resourceIconTypes'

const WEBP = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=', 'base64')

function distinctWebp(index: number): Buffer {
  const data = Buffer.from(WEBP)
  data[data.length - 1] = index
  return data
}

function catalogEntry(id: string, kind: 'agent' | 'skill', data: Buffer): Record<string, unknown> {
  return {
    id,
    name: id,
    category: kind === 'agent' ? 'animals' : 'objects',
    kinds: [kind],
    path: `${kind}/${id}.webp`,
    sourceUrl: `https://cdn.ipaslogo.com/display-512/${id}.webp`,
    sha256: createHash('sha256').update(data).digest('hex'),
    size: data.length
  }
}

function writeFixture(root: string): void {
  const entries: Record<string, unknown>[] = []
  for (const [index, kind] of ['agent', 'agent', 'skill', 'skill'].entries()) {
    const typedKind = kind as 'agent' | 'skill'
    const id = `${typedKind}-${index}`
    const data = distinctWebp(index)
    mkdirSync(join(root, typedKind), { recursive: true })
    writeFileSync(join(root, typedKind, `${id}.webp`), data)
    entries.push(catalogEntry(id, typedKind, data))
  }
  writeFileSync(
    join(root, 'catalog.json'),
    JSON.stringify({
      schemaVersion: 1,
      catalogVersion: 'test-v1',
      sourceUrl: 'https://github.com/s1dashu/ip-as-logo-skill',
      websiteUrl: 'https://ipaslogo.com/',
      commercialUse: {
        statement: 'Free for commercial use.',
        sourceUrl: 'https://ipaslogo.com/'
      },
      entries
    })
  )
}

function fixture(callback: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'phi-curated-icons-'))
  try {
    writeFixture(root)
    callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('curated fallback selection is stable, kind-scoped, and varied', () => {
  fixture((root) => {
    const agentValues = new Set<string>()
    const skillValues = new Set<string>()
    for (let index = 0; index < 64; index += 1) {
      const stableId = `resource-${index}`
      const agent = resolveCuratedResourceIcon('agent', stableId, root)
      const skill = resolveCuratedResourceIcon('skill', stableId, root)
      assert.ok(agent)
      assert.ok(skill)
      assert.deepEqual(resolveCuratedResourceIcon('agent', stableId, root), agent)
      assert.deepEqual(resolveCuratedResourceIcon('skill', stableId, root), skill)
      const agentValue = readResourceIcon(agent.key)
      const skillValue = readResourceIcon(skill.key)
      assert.ok(agentValue)
      assert.ok(skillValue)
      agentValues.add(agentValue)
      skillValues.add(skillValue)
    }
    assert.equal(agentValues.size, 2)
    assert.equal(skillValues.size, 2)
    assert.equal(
      [...agentValues].some((value) => skillValues.has(value)),
      false
    )
  })
})

test('validated registrations are reused without reopening every fallback asset', () => {
  fixture((root) => {
    const first = resolveCuratedResourceIcon('agent', 'stable-agent', root)
    assert.ok(first)
    rmSync(join(root, 'agent'), { recursive: true, force: true })
    assert.deepEqual(resolveCuratedResourceIcon('agent', 'stable-agent', root), first)
    assert.equal(readResourceIcon(first.key), null)
  })
})

test('malformed or missing catalogs and assets degrade to no fallback icon', () => {
  fixture((root) => {
    writeFileSync(join(root, 'catalog.json'), '{')
    assert.equal(resolveCuratedResourceIcon('agent', 'alpha', root), undefined)
  })
  fixture((root) => {
    const catalogPath = join(root, 'catalog.json')
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
      entries: Array<{ kind?: string; kinds: string[]; path: string; sha256: string }>
    }
    catalog.entries[0].kinds = ['unknown']
    writeFileSync(catalogPath, JSON.stringify(catalog))
    assert.equal(resolveCuratedResourceIcon('agent', 'alpha', root), undefined)
  })
  fixture((root) => {
    const catalogPath = join(root, 'catalog.json')
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
      entries: Array<{ path: string; sha256: string }>
    }
    rmSync(join(root, catalog.entries[0].path))
    assert.equal(resolveCuratedResourceIcon('agent', 'alpha', root), undefined)
  })
  fixture((root) => {
    const catalogPath = join(root, 'catalog.json')
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
      entries: Array<{ sha256: string }>
    }
    catalog.entries[0].sha256 = 'f'.repeat(64)
    writeFileSync(catalogPath, JSON.stringify(catalog))
    assert.equal(resolveCuratedResourceIcon('agent', 'alpha', root), undefined)
  })
})

test('bundled curated catalog contains sixteen verified 512px WebP thumbnails', () => {
  const root = join(process.cwd(), 'resources', 'icons')
  const catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8')) as {
    schemaVersion: number
    catalogVersion: string
    sourceUrl: string
    websiteUrl: string
    commercialUse: { statement: string; sourceUrl: string }
    entries: Array<{
      id: string
      name: string
      category: string
      kinds: Array<'agent' | 'skill'>
      path: string
      sourceUrl: string
      sha256: string
      size: number
    }>
  }
  assert.equal(catalog.schemaVersion, 1)
  assert.ok(catalog.catalogVersion)
  assert.equal(catalog.sourceUrl, 'https://github.com/s1dashu/ip-as-logo-skill')
  assert.equal(catalog.websiteUrl, 'https://ipaslogo.com/')
  assert.match(catalog.commercialUse.statement, /commercial/i)
  assert.match(catalog.commercialUse.sourceUrl, /^https:\/\//)
  assert.equal(catalog.entries.length, 16)
  assert.equal(catalog.entries.filter((entry) => entry.kinds.includes('agent')).length, 8)
  assert.equal(catalog.entries.filter((entry) => entry.kinds.includes('skill')).length, 8)

  for (const entry of catalog.entries) {
    assert.match(entry.sourceUrl, /^https:\/\/cdn\.ipaslogo\.com\/display-512\/.+\.webp$/)
    assert.match(entry.path, /^(agent|skill)\/[a-z0-9-]+\.webp$/)
    const data = readFileSync(join(root, entry.path))
    assert.equal(data.length, entry.size, entry.id)
    assert.ok(data.length > 0 && data.length <= RESOURCE_ICON_MAX_BYTES, entry.id)
    assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, entry.id)
    assert.equal(data.toString('ascii', 0, 4), 'RIFF', entry.id)
    assert.equal(data.toString('ascii', 8, 12), 'WEBP', entry.id)
    const chunk = data.toString('ascii', 12, 16)
    if (chunk === 'VP8X') {
      assert.equal(data.readUIntLE(24, 3) + 1, 512, entry.id)
      assert.equal(data.readUIntLE(27, 3) + 1, 512, entry.id)
    } else if (chunk === 'VP8L') {
      const dimensions = data.readUInt32LE(21)
      assert.equal((dimensions & 0x3fff) + 1, 512, entry.id)
      assert.equal(((dimensions >>> 14) & 0x3fff) + 1, 512, entry.id)
    } else {
      assert.equal(data.readUInt16LE(26) & 0x3fff, 512, entry.id)
      assert.equal(data.readUInt16LE(28) & 0x3fff, 512, entry.id)
    }
  }
})
