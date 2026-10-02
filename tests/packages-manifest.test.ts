import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import {
  PACKAGE_CONTRACT_VERSION,
  packageManifestSchema,
  parsePackageManifestText,
  validatePackage
} from '../src/main/agent/packages/manifest'
function writeSkill(root: string, manifest: Record<string, unknown> = {}): string {
  const dir = join(root, 'alpha-skill')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: alpha-skill\ndescription: Alpha skill.\n---\n\n# Alpha\n',
    'utf8'
  )
  writeFileSync(
    join(dir, 'phi-package.yaml'),
    stringifyYaml({
      schemaVersion: 1,
      id: 'alpha-skill',
      type: 'skill',
      version: '1.0.0',
      title: 'Alpha skill',
      summary: 'Alpha skill.',
      ...manifest
    }),
    'utf8'
  )
  return dir
}

test('published package schema is the runtime schema', () => {
  assert.equal(PACKAGE_CONTRACT_VERSION, '1.1.0')
  const published = JSON.parse(
    readFileSync(resolve('docs/contracts/package.schema.json'), 'utf8')
  ) as unknown
  assert.deepEqual(packageManifestSchema, published)
})

test('validates a standalone skill package and its id', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-package-manifest-'))
  try {
    assert.equal(validatePackage(writeSkill(root)).ok, true)
    const invalid = validatePackage(writeSkill(root, { id: 'different-id' }))
    assert.equal(invalid.ok, false)
    assert.match(
      invalid.errors.map((problem) => problem.message).join('\n'),
      /must equal package id/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preserves shared fields and delegates plugin validation', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-package-plugin-'))
  try {
    const dir = join(root, 'alpha-plugin')
    mkdirSync(join(dir, 'skills', 'plugin-skill'), { recursive: true })
    writeFileSync(
      join(dir, 'skills', 'plugin-skill', 'SKILL.md'),
      '---\nname: plugin-skill\ndescription: Plugin skill.\n---\n# Plugin\n'
    )
    writeFileSync(
      join(dir, 'phi-package.yaml'),
      stringifyYaml({
        schemaVersion: 1,
        id: 'alpha-plugin',
        type: 'plugin',
        version: '1.0.0',
        title: 'Alpha plugin',
        summary: 'Alpha plugin.',
        minAppVersion: '0.9.0',
        requires: { coreTools: ['skill_run'] },
        dependsOn: [{ id: 'alpha-skill', type: 'skill', version: '^1.0.0' }],
        files: 'files.json',
        toolPrefix: 'alphap',
        components: { skills: ['skills/plugin-skill'] }
      })
    )
    const result = validatePackage(dir)
    assert.equal(result.ok, true, result.errors.map((problem) => problem.message).join('\n'))
    assert.equal(result.package?.plugin?.manifest.minAppVersion, '0.9.0')
    assert.deepEqual(result.package?.manifest.requires, { coreTools: ['skill_run'] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects unknown fields and invalid dependency ranges', () => {
  assert.throws(
    () =>
      parsePackageManifestText(
        stringifyYaml({
          schemaVersion: 1,
          id: 'alpha-skill',
          type: 'skill',
          version: '1.0.0',
          title: 'Alpha',
          summary: 'Alpha.',
          surprise: true
        })
      ),
    /unknown field 'surprise'/
  )
  assert.throws(
    () =>
      parsePackageManifestText(
        stringifyYaml({
          schemaVersion: 1,
          id: 'alpha-skill',
          type: 'skill',
          version: '1.0.0',
          title: 'Alpha',
          summary: 'Alpha.',
          dependsOn: [{ id: 'beta-skill', type: 'skill', version: 'definitely not semver' }]
        })
      ),
    /not a semver range/
  )
})

test('accepts wrapper and valid http and stdio connector package manifests', () => {
  const wrapper = parseYaml(`
schemaVersion: 1
id: alpha-wrapper
type: wrapper
version: 1.0.0
title: Alpha
summary: Alpha.
`)
  assert.equal(parsePackageManifestText(stringifyYaml(wrapper)).type, 'wrapper')

  const http = {
    ...wrapper,
    type: 'mcp',
    id: 'alpha-mcp',
    connector: {
      transport: 'http',
      publisher: 'Phi',
      category: '科研数据',
      homepage: 'https://example.com/alpha',
      url: 'https://example.com/mcp',
      auth: 'oauth'
    }
  }
  assert.deepEqual(parsePackageManifestText(stringifyYaml(http)).connector, http.connector)

  const stdio = {
    ...http,
    connector: {
      transport: 'stdio',
      publisher: 'Phi',
      category: '科研数据',
      environment: './environment.yml',
      command: './server/run.py',
      args: ['--root', '${package}']
    }
  }
  assert.deepEqual(parsePackageManifestText(stringifyYaml(stdio)).connector, stdio.connector)

  const root = mkdtempSync(join(tmpdir(), 'phi-package-mcp-'))
  try {
    writeFileSync(join(root, 'phi-package.yaml'), stringifyYaml(http))
    const result = validatePackage(root)
    assert.equal(result.ok, true, result.errors.map((problem) => problem.message).join('\n'))
    assert.equal(result.package?.manifest.type, 'mcp')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('connector transport fields are conditional and connector keys are closed', () => {
  const base = {
    schemaVersion: 1,
    id: 'alpha-mcp',
    type: 'mcp',
    version: '1.0.0',
    title: 'Alpha',
    summary: 'Alpha.',
    connector: {
      transport: 'http',
      publisher: 'Phi',
      category: '生产力',
      url: 'https://example.com/mcp',
      auth: 'none'
    }
  }

  const invalidConnectors = [
    { ...base.connector, url: 'http://example.com/mcp' },
    { ...base.connector, category: '未知分类' },
    { ...base.connector, environment: 'phi:python@1' },
    { ...base.connector, secrets: ['TOKEN'] },
    {
      transport: 'stdio',
      publisher: 'Phi',
      category: '生产力',
      environment: 'phi:python@1'
    },
    {
      transport: 'stdio',
      publisher: 'Phi',
      category: '生产力',
      environment: './other.yml',
      command: 'python'
    },
    {
      transport: 'stdio',
      publisher: 'Phi',
      category: '生产力',
      environment: 'phi:python@1',
      command: 'python',
      auth: 'none'
    },
    {
      transport: 'stdio',
      publisher: 'Phi',
      category: '生产力',
      environment: 'phi:python@1',
      command: './server/../outside'
    }
  ]

  for (const connector of invalidConnectors) {
    assert.throws(() => parsePackageManifestText(stringifyYaml({ ...base, connector })))
  }

  assert.throws(
    () => parsePackageManifestText(stringifyYaml({ ...base, connector: undefined })),
    /connector/
  )
})
