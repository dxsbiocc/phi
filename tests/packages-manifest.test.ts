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
  assert.equal(PACKAGE_CONTRACT_VERSION, '1.0.0')
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

test('rejects unknown fields, invalid dependency ranges, and reserved package types', () => {
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
  const wrapper = parseYaml(`
schemaVersion: 1
id: alpha-wrapper
type: wrapper
version: 1.0.0
title: Alpha
summary: Alpha.
`)
  assert.throws(() => parsePackageManifestText(stringifyYaml(wrapper)), /reserved.*not supported/)
  const mcp = { ...wrapper, type: 'mcp', id: 'alpha-mcp' }
  assert.throws(() => parsePackageManifestText(stringifyYaml(mcp)), /reserved.*not supported/)
})
