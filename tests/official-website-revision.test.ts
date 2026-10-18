import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import { sha256 } from '../src/main/agent/packages/installer-utils'
import {
  officialWebsiteRegistryDirectory,
  readOfficialWebsiteRegistry,
  syncPreferredOfficialRegistry
} from '../src/main/agent/packages/official-website-registry'
import type { LocalRegistry } from '../src/main/agent/packages/installer-types'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
const commit = 'c'.repeat(40)
const generatedAt = '2026-10-17T04:15:05.147Z'
const obsoleteNotice = '官网目录有 1 项资源暂不可用：wrapper：4 个引用无法归属'

function fixture(): {
  agentDir: string
  requests: string[]
  options: Parameters<typeof syncPreferredOfficialRegistry>[0]
  failSnapshot: () => void
} {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-materializer-revision-'))
  roots.push(agentDir)
  const requests: string[] = []
  const groups = [
    { id: 'all', label: 'All', count: 1 },
    { id: 'domain', label: 'Official category', count: 1 }
  ]
  const archive = createDeterministicTarGz([
    {
      path: `phi-packages-${commit}/resources/skills/revision-skill/SKILL.md`,
      data: Buffer.from(
        '---\nname: revision-skill\ndescription: Complete fixture\nmetadata: {version: "1.1"}\n---\n# Fixture\n'
      )
    },
    {
      path: `phi-packages-${commit}/resources/skills/revision-skill/references/guide.md`,
      data: Buffer.from('Complete guide')
    }
  ])
  let failing = false
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url === 'https://phi.omicsagent.cn/api/catalog')
      return Response.json({ commit, generatedAt, counts: { skills: 1 }, skillGroups: groups })
    if (url === 'https://phi.omicsagent.cn/api/skills?page=1&pageSize=100')
      return Response.json({
        items: [{ id: 'revision-skill', group: 'domain', groupLabel: 'Official category' }],
        groups: groups.slice(1),
        total: 1,
        page: 1,
        pageSize: 100,
        pageCount: 1
      })
    if (url === `https://codeload.github.com/dxsbiocc/phi-packages/tar.gz/${commit}`) {
      if (failing) throw new Error('snapshot rebuild unavailable')
      return new Response(new Uint8Array(archive))
    }
    return new Response(null, { status: 404 })
  }
  return {
    agentDir,
    requests,
    options: { agentDir, fetch: fetcher, forceRefresh: true, timeoutMs: 1000 },
    failSnapshot: () => {
      failing = true
    }
  }
}

function legacyGeneration(registry: LocalRegistry, agentDir: string): string {
  const root = officialWebsiteRegistryDirectory(agentDir)
  const index = JSON.parse(readFileSync(join(registry.dir, 'index.json'), 'utf8')) as Record<
    string,
    unknown
  >
  delete index.materializerRevision
  index.legacyFixture = true
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`)
  const generation = `${commit}-${sha256(indexBytes)}`
  const directory = join(root, 'generations', generation)
  cpSync(registry.dir, directory, { recursive: true, errorOnExist: true, force: false })
  writeFileSync(join(directory, 'index.json'), indexBytes)
  const metadata = JSON.parse(
    readFileSync(join(directory, 'website-source.json'), 'utf8')
  ) as Record<string, unknown>
  delete metadata.materializerRevision
  metadata.index = { path: 'index.json', sha256: sha256(indexBytes), size: indexBytes.length }
  metadata.notice = obsoleteNotice
  writeFileSync(join(directory, 'website-source.json'), `${JSON.stringify(metadata)}\n`)
  writeFileSync(join(root, 'current.json'), JSON.stringify({ version: 1, generation }))
  return directory
}

test('same-commit legacy materialization rebuilds immutable content and replaces obsolete diagnostics once', async () => {
  const f = fixture()
  const original = await syncPreferredOfficialRegistry(f.options)
  const legacy = legacyGeneration(original, f.agentDir)
  assert.equal(readOfficialWebsiteRegistry(legacy, { agentDir: f.agentDir }).notice, obsoleteNotice)
  const rebuilt = await syncPreferredOfficialRegistry({ ...f.options, forceRefresh: false })
  assert.equal(rebuilt.notice, undefined)
  assert.notEqual(rebuilt.dir, legacy)
  assert.equal(rebuilt.packages[0].sha256, original.packages[0].sha256)
  assert.deepEqual(rebuilt.skillGroups, original.skillGroups)
  assert.equal(rebuilt.packages[0].group, 'domain')
  const index = JSON.parse(readFileSync(join(rebuilt.dir, 'index.json'), 'utf8'))
  const metadata = JSON.parse(readFileSync(join(rebuilt.dir, 'website-source.json'), 'utf8'))
  assert.equal(index.materializerRevision, 2)
  assert.equal(metadata.materializerRevision, 2)
  assert.equal(f.requests.filter((url) => url.includes('codeload.github.com')).length, 2)
  assert.equal(readOfficialWebsiteRegistry(legacy, { agentDir: f.agentDir }).notice, obsoleteNotice)
  const repeat = await syncPreferredOfficialRegistry(f.options)
  assert.equal(repeat.dir, rebuilt.dir)
  assert.equal(f.requests.filter((url) => url.includes('codeload.github.com')).length, 2)
})

test('failed revision rebuild preserves the valid legacy generation with an explicit cached notice', async () => {
  const f = fixture()
  const original = await syncPreferredOfficialRegistry(f.options)
  const legacy = legacyGeneration(original, f.agentDir)
  f.failSnapshot()
  const fallback = await syncPreferredOfficialRegistry(f.options)
  assert.equal(fallback.dir, legacy)
  assert.equal(fallback.status, 'cached')
  assert.match(fallback.notice ?? '', /snapshot rebuild unavailable/)
  assert.match(fallback.notice ?? '', /4 个引用/)
  assert.equal(
    readOfficialWebsiteRegistry(legacy, { agentDir: f.agentDir }).packages[0].sha256,
    original.packages[0].sha256
  )
})

test('cache rejects revision metadata that disagrees with its immutable index', async () => {
  const f = fixture()
  const registry = await syncPreferredOfficialRegistry(f.options)
  const path = join(registry.dir, 'website-source.json')
  const metadata = JSON.parse(readFileSync(path, 'utf8'))
  metadata.materializerRevision = 99
  writeFileSync(path, JSON.stringify(metadata))
  assert.throws(
    () => readOfficialWebsiteRegistry(registry.dir, { agentDir: f.agentDir }),
    /revision|版本/
  )
})
