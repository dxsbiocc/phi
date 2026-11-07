import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fallbackSkillCatalogGroups,
  officialSkillCatalogGroups,
  registryPackageForOfficialSkill,
  resolveSkillCatalogGroupId,
  type SkillCatalogPackage
} from '../src/renderer/src/features/skill/lib/skillCatalogBrowser'
import type {
  PhiSkillCatalogGroup,
  PhiSkillCatalogItem
} from '../src/shared/phiWebsiteCatalogTypes'

const websiteGroups: PhiSkillCatalogGroup[] = [
  { id: 'nextflow', label: '工作流', count: 7 },
  { id: 'science', label: '科学分析', count: 12 }
]

const websiteSkill: PhiSkillCatalogItem = {
  id: 'scanpy',
  slug: 'scanpy',
  kind: 'skill',
  title: 'Scanpy',
  description: 'Single-cell analysis',
  path: 'resources/skills/scanpy',
  version: '2.0.0',
  source: 'Phi Packages',
  group: 'science',
  groupLabel: '科学分析'
}

const registryPackages: SkillCatalogPackage[] = [
  {
    id: 'scanpy',
    type: 'skill',
    version: '2.0.0',
    title: 'Registry Scanpy',
    summary: 'Install metadata',
    archive: 'scanpy.tgz',
    sha256: 'a'.repeat(64),
    size: 1024,
    dependsOn: [],
    registryDir: '/registry'
  },
  {
    id: 'unrelated',
    type: 'skill',
    version: '1.0.0',
    title: 'Unrelated',
    summary: '',
    archive: 'unrelated.tgz',
    sha256: 'b'.repeat(64),
    size: 512,
    dependsOn: [],
    registryDir: '/registry'
  }
]

test('official skill groups preserve website order and labels while fallback stays flat', () => {
  assert.deepEqual(officialSkillCatalogGroups(websiteGroups), websiteGroups)
  assert.equal(resolveSkillCatalogGroupId(websiteGroups, 'science'), 'science')
  assert.equal(resolveSkillCatalogGroupId(websiteGroups, 'missing'), 'nextflow')
  assert.deepEqual(fallbackSkillCatalogGroups(23), [
    { id: 'all', label: 'All Skills', count: 23 }
  ])
})

test('official browse metadata resolves installation only through the matching registry entry', () => {
  assert.equal(registryPackageForOfficialSkill(websiteSkill, registryPackages)?.title, 'Registry Scanpy')
  assert.equal(
    registryPackageForOfficialSkill({ ...websiteSkill, id: 'browse-only' }, registryPackages),
    undefined
  )
})
