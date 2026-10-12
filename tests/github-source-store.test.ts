import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { stringify as stringifyYaml } from 'yaml'

import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import { readRegistry } from '../src/main/agent/packages/registry'
import {
  addGithubSource,
  applyGithubSourceUpdate,
  checkGithubSourceUpdate,
  listGithubSources,
  previewGithubSource,
  removeGithubSource
} from '../src/main/agent/packages/github-source'

import {
  githubSourceId,
  githubSourcesPath,
  readGithubSources,
  removeGithubSourceRecord,
  saveGithubSource,
  updateGithubSourceRecord,
  type GithubSourceRecord
} from '../src/main/agent/packages/github-source-store'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function sandbox(): { root: string; agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'phi-github-store-'))
  roots.push(root)
  return { root, agentDir: join(root, 'agent') }
}

function source(agentDir: string, overrides: Partial<GithubSourceRecord> = {}): GithubSourceRecord {
  const repo = overrides.repo ?? 'acme/connectors'
  return {
    id: githubSourceId(repo),
    repo,
    ref: 'main',
    sha: 'a'.repeat(40),
    registryPath: join(
      agentDir,
      'cache',
      'sources',
      'github',
      'acme',
      'connectors',
      'a'.repeat(40),
      'registry'
    ),
    addedAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z',
    ...overrides
  }
}

test('persists, loads, updates, and removes GitHub sources atomically', () => {
  const { agentDir } = sandbox()
  const initial = source(agentDir)
  assert.deepEqual(saveGithubSource(initial, { agentDir }), initial)
  assert.deepEqual(readGithubSources(agentDir), { version: 1, sources: [initial] })
  assert.deepEqual(JSON.parse(readFileSync(githubSourcesPath(agentDir), 'utf8')), {
    version: 1,
    sources: [initial]
  })

  const changed = updateGithubSourceRecord(
    initial.id,
    {
      sha: 'b'.repeat(40),
      registryPath: initial.registryPath.replace('a'.repeat(40), 'b'.repeat(40)),
      updatedAt: '2026-10-12T00:00:00.000Z'
    },
    { agentDir }
  )
  assert.equal(changed.sha, 'b'.repeat(40))
  assert.equal(changed.addedAt, initial.addedAt)
  assert.equal(removeGithubSourceRecord(initial.id, { agentDir }), true)
  assert.equal(removeGithubSourceRecord(initial.id, { agentDir }), false)
  assert.deepEqual(readGithubSources(agentDir), { version: 1, sources: [] })
})

test('corrupt GitHub state disables only GitHub mutations and leaves registries.json untouched', () => {
  const { agentDir } = sandbox()
  const githubPath = githubSourcesPath(agentDir)
  const registriesPath = join(agentDir, 'state', 'registries.json')
  mkdirSync(dirname(githubPath), { recursive: true })
  writeFileSync(githubPath, '{broken')
  writeFileSync(registriesPath, '{"version":1,"registries":[]}\n')

  const loaded = readGithubSources(agentDir)
  assert.deepEqual(loaded.sources, [])
  assert.match(loaded.error ?? '', /GitHub 软件源配置文件无效/)
  assert.throws(() => saveGithubSource(source(agentDir), { agentDir }), /请先修复或移走该文件/)
  assert.equal(readFileSync(githubPath, 'utf8'), '{broken')
  assert.equal(readFileSync(registriesPath, 'utf8'), '{"version":1,"registries":[]}\n')
})

test('validates identities, timestamps, and absolute registry paths on load', () => {
  const { agentDir } = sandbox()
  const path = githubSourcesPath(agentDir)
  mkdirSync(dirname(path), { recursive: true })
  const valid = source(agentDir)
  const invalid = [
    { ...valid, id: '0'.repeat(16) },
    { ...valid, sha: 'bad' },
    { ...valid, registryPath: 'relative/registry' },
    { ...valid, addedAt: 'not-a-date' },
    { ...valid, unexpected: true }
  ]
  for (const entry of invalid) {
    writeFileSync(path, JSON.stringify({ version: 1, sources: [entry] }))
    assert.match(readGithubSources(agentDir).error ?? '', /GitHub 软件源配置文件无效/)
  }
})

function githubArchive(sha: string, version: string): Buffer {
  return createDeterministicTarGz([
    {
      path: `connectors-${sha}/phi-package.yaml`,
      data: Buffer.from(
        stringifyYaml({
          schemaVersion: 1,
          id: 'alpha',
          type: 'mcp',
          version,
          title: 'Alpha',
          summary: 'Alpha connector',
          connector: {
            transport: 'stdio',
            publisher: 'Acme',
            category: '科研数据',
            environment: './environment.yml',
            command: './server.sh',
            args: ['--stdio']
          }
        })
      )
    },
    { path: `connectors-${sha}/server.sh`, data: Buffer.from('#!/bin/sh\n') }
  ])
}

test('preview/add/check/apply/remove stays pinned and never installs package code', async () => {
  const { agentDir } = sandbox()
  const sha1 = '1'.repeat(40)
  const sha2 = '2'.repeat(40)
  let resolvedSha = sha1
  const downloads: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    if (url.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({ sha: resolvedSha }), { status: 200 })
    }
    if (url.includes('/info/refs')) {
      // Ref resolution goes through the anonymous git advertisement, not the rate-limited API.
      const line = `${resolvedSha} HEAD\0symref=HEAD:refs/heads/main\n`
      const packet = (text: string): string =>
        `${(text.length + 4).toString(16).padStart(4, '0')}${text}`
      return new Response(
        Buffer.from(`${packet('# service=git-upload-pack\n')}0000${packet(line)}0000`),
        { status: 200 }
      )
    }
    downloads.push(url)
    const requestedSha = url.split('/').at(-1)!
    return new Response(githubArchive(requestedSha, requestedSha === sha1 ? '1.0.0' : '2.0.0'), {
      status: 200
    })
  }
  const options = {
    agentDir,
    fetch: fetcher,
    now: () => new Date('2026-10-11T00:00:00.000Z')
  }

  const preview = await previewGithubSource('https://github.com/acme/connectors/tree/main', options)
  assert.equal(preview.sha, sha1)
  assert.deepEqual(
    preview.packages.map((entry) => entry.id),
    ['alpha']
  )
  assert.equal(preview.projectHint, undefined)
  assert.equal(preview.localDraft, undefined)
  assert.equal(existsSync(join(agentDir, 'packages')), false)

  const added = await addGithubSource(
    { url: 'https://github.com/acme/connectors/tree/main', sha: sha1 },
    options
  )
  assert.equal(added.sha, sha1)
  assert.equal(downloads.length, 2, 'add must freshly fetch the previewed sha')
  assert.equal(existsSync(join(added.registryPath, 'index.json')), true)
  assert.equal(existsSync(join(agentDir, 'packages')), false)
  assert.deepEqual(listGithubSources({ agentDir }).sources, [added])

  resolvedSha = sha2
  const update = await checkGithubSourceUpdate(added.id, options)
  assert.equal(update.changed, true)
  if (!update.changed) assert.fail('expected update')
  assert.equal(update.sha, sha2)
  assert.deepEqual(update.diff, {
    added: [],
    removed: [],
    changed: [{ id: 'alpha', fromVersion: '1.0.0', toVersion: '2.0.0' }]
  })
  assert.equal(readGithubSources(agentDir).sources[0]?.sha, sha1)

  const updated = await applyGithubSourceUpdate(added.id, sha2, options)
  assert.equal(updated.sha, sha2)
  assert.equal(
    existsSync(join(agentDir, 'cache', 'sources', 'github', 'acme', 'connectors', sha1)),
    false
  )

  const installedMarker = join(agentDir, 'packages', 'mcp', 'alpha', '1.0.0', 'marker')
  mkdirSync(dirname(installedMarker), { recursive: true })
  writeFileSync(installedMarker, 'installed')
  assert.equal(await removeGithubSource(added.id, options), true)
  assert.equal(readFileSync(installedMarker, 'utf8'), 'installed')
  assert.deepEqual(listGithubSources({ agentDir }).sources, [])
})

test('add rejects a freshly fetched snapshot whose GitHub root does not match the previewed sha', async () => {
  const { agentDir } = sandbox()
  const previewedSha = '3'.repeat(40)
  const differentSha = '4'.repeat(40)
  await assert.rejects(
    addGithubSource(
      { url: 'https://github.com/acme/connectors', sha: previewedSha },
      {
        agentDir,
        fetch: async () => new Response(githubArchive(differentSha, '1.0.0'), { status: 200 })
      }
    ),
    /预览的提交|SHA|快照/
  )
  assert.deepEqual(readGithubSources(agentDir), { version: 1, sources: [] })
})

test('remove refuses a persisted registry path outside the validated GitHub cache root', async () => {
  const { root, agentDir } = sandbox()
  const outside = join(root, 'outside-registry')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'keep'), 'safe')
  const unsafe = source(agentDir, { registryPath: outside })
  mkdirSync(dirname(githubSourcesPath(agentDir)), { recursive: true })
  writeFileSync(githubSourcesPath(agentDir), JSON.stringify({ version: 1, sources: [unsafe] }))

  await assert.rejects(removeGithubSource(unsafe.id, { agentDir }), /配置文件无效|越过受管缓存/)
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'safe')
  assert.match(readGithubSources(agentDir).error ?? '', /配置文件无效/)
})

test('a prebuilt GitHub registry is re-materialized with MCP packages only', async () => {
  const { agentDir } = sandbox()
  const sha = '5'.repeat(40)
  const mcpManifest = Buffer.from(
    stringifyYaml({
      schemaVersion: 1,
      id: 'alpha',
      type: 'mcp',
      version: '1.0.0',
      title: 'Alpha',
      summary: 'Alpha connector',
      connector: {
        transport: 'http',
        publisher: 'Acme',
        category: '科研数据',
        url: 'https://alpha.example/mcp',
        auth: 'none'
      }
    })
  )
  const skillManifest = Buffer.from(
    stringifyYaml({
      schemaVersion: 1,
      id: 'helper',
      type: 'skill',
      version: '1.0.0',
      title: 'Helper',
      summary: 'Unsupported helper skill'
    })
  )
  const mcpArchive = createDeterministicTarGz([{ path: 'phi-package.yaml', data: mcpManifest }])
  const skillArchive = createDeterministicTarGz([{ path: 'phi-package.yaml', data: skillManifest }])
  const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex')
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-10-11T00:00:00.000Z',
      packages: [
        {
          id: 'alpha',
          type: 'mcp',
          version: '1.0.0',
          title: 'Alpha',
          summary: 'Alpha connector',
          archive: 'mcp-alpha-1.0.0.tar.gz',
          sha256: digest(mcpArchive),
          size: mcpArchive.length,
          dependsOn: []
        },
        {
          id: 'helper',
          type: 'skill',
          version: '1.0.0',
          title: 'Helper',
          summary: 'Unsupported helper skill',
          archive: 'skill-helper-1.0.0.tar.gz',
          sha256: digest(skillArchive),
          size: skillArchive.length,
          dependsOn: []
        }
      ]
    })
  )
  const outer = createDeterministicTarGz([
    { path: `connectors-${sha}/index.json`, data: index },
    { path: `connectors-${sha}/mcp-alpha-1.0.0.tar.gz`, data: mcpArchive },
    { path: `connectors-${sha}/skill-helper-1.0.0.tar.gz`, data: skillArchive }
  ])

  const added = await addGithubSource(
    { url: 'https://github.com/acme/connectors', sha },
    { agentDir, fetch: async () => new Response(outer, { status: 200 }) }
  )
  assert.deepEqual(
    readRegistry(added.registryPath).packages.map((entry) => `${entry.type}:${entry.id}`),
    ['mcp:alpha']
  )
})
