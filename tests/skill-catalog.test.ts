import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PackageRegistryEntryView,
  PackageRegistryView
} from '../src/shared/packageManagerTypes'
import type { SkillSummary } from '../src/shared/skillTypes'
import {
  bundledCatalogSkills,
  formatPackageSize,
  registrySkillPackages,
  skillSourceLabel
} from '../src/renderer/src/features/skill/lib/skillCatalog'

function skill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: '/skills/scanpy/SKILL.md',
    name: 'scanpy',
    description: 'Single-cell analysis',
    filePath: '/skills/scanpy/SKILL.md',
    source: 'bundled',
    scope: 'user',
    sourceCategory: 'bundled',
    sourceCategoryLabel: '内置',
    enabled: false,
    globalEnabled: false,
    globalOverride: null,
    projectOverride: null,
    core: false,
    disabled: true,
    ...overrides
  }
}

function registryEntry(
  id: string,
  type: PackageRegistryEntryView['type']
): PackageRegistryEntryView {
  return {
    id,
    type,
    version: '1.0.0',
    title: id,
    summary: `${id} summary`,
    archive: `${id}.tar.gz`,
    sha256: 'a'.repeat(64),
    size: 1536,
    dependsOn: []
  }
}

test('skill source labels match the Skills page Chinese copy', () => {
  assert.equal(skillSourceLabel(skill()), '内置')
  assert.equal(skillSourceLabel(skill({ core: true })), '内置·核心')
  assert.equal(skillSourceLabel(skill({ sourceCategory: 'installed-package' })), '已安装')
  assert.equal(skillSourceLabel(skill({ sourceCategory: 'user' })), '我的')
  assert.equal(skillSourceLabel(skill({ sourceCategory: 'project' })), '项目')
  assert.equal(
    skillSourceLabel(
      skill({ sourceCategory: 'plugin', source: 'fallback', sourceId: 'visualization' })
    ),
    '插件: visualization'
  )
})

test('bundled catalog includes disabled non-core bundled skills only', () => {
  const disabledBundled = skill()
  const result = bundledCatalogSkills([
    disabledBundled,
    skill({ id: 'core', name: 'nextflow', core: true }),
    skill({
      id: 'enabled',
      name: 'pptx',
      enabled: false,
      globalEnabled: true,
      projectOverride: false,
      disabled: true
    }),
    skill({ id: 'user', name: 'mine', sourceCategory: 'user' })
  ])

  assert.deepEqual(result, [disabledBundled])
})

test('registry catalog filters to skill packages and formats package sizes', () => {
  const skillPackage = registryEntry('scanpy', 'skill')
  const registry: PackageRegistryView = {
    id: 'local',
    dir: '/registry',
    schemaVersion: 1,
    generatedAt: '2026-10-02T00:00:00.000Z',
    packages: [skillPackage, registryEntry('visualization', 'plugin')]
  }

  assert.deepEqual(registrySkillPackages(registry), [skillPackage])
  assert.equal(formatPackageSize(0), '0 B')
  assert.equal(formatPackageSize(800), '800 B')
  assert.equal(formatPackageSize(1536), '1.5 KB')
  assert.equal(formatPackageSize(10 * 1024), '10 KB')
  assert.equal(formatPackageSize(2 * 1024 * 1024), '2 MB')
})

test('deprecated bundled skills stay in the catalog but sort last', () => {
  const result = bundledCatalogSkills([
    skill({ name: 'pptx', sourceCategory: 'bundled', deprecated: '即将由 OfficeCLI 替代。' }),
    skill({ name: 'scanpy', sourceCategory: 'bundled' }),
    skill({ name: 'xlsx', sourceCategory: 'bundled', deprecated: '即将由 OfficeCLI 替代。' })
  ])
  assert.deepEqual(
    result.map((item) => item.name),
    ['scanpy', 'pptx', 'xlsx']
  )
})
