import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { discoverSkillSources, skillSourceCategory } from '../src/main/agent/content/skill-sources'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture(): { root: string; skills: string } {
  const root = mkdtempSync(join(tmpdir(), 'phi-skill-sources-'))
  roots.push(root)
  const skills = join(root, 'skills')
  mkdirSync(skills)
  return { root, skills }
}

function skill(root: string, path: string): string {
  const directory = join(root, path)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${path.split('/').at(-1)}\ndescription: Test\n---\n# Skill\n`
  )
  return directory
}

test('discovers flat and grouped sources with complete multi-level category paths', () => {
  const f = fixture()
  const flat = skill(f.skills, 'flat-skill')
  const first = skill(f.skills, 'biology/first-skill')
  const nested = skill(f.skills, 'analysis/rnaseq/nested-skill')
  assert.deepEqual(discoverSkillSources(f.skills), [
    { dir: nested, category: 'analysis/rnaseq' },
    { dir: first, category: 'biology' },
    { dir: flat }
  ])
})

test('embedded reference SKILL.md files remain resources after a skill root is discovered', () => {
  const f = fixture()
  const outer = skill(f.skills, 'group/outer-skill')
  skill(outer, 'references/example-skill')
  skill(outer, 'scripts/nested-skill')
  assert.deepEqual(discoverSkillSources(f.skills), [{ dir: outer, category: 'group' }])
})

test('a supplied skill root has no category outside the discovery boundary', () => {
  const f = fixture()
  writeFileSync(
    join(f.skills, 'SKILL.md'),
    '---\nname: skills\ndescription: Root skill\n---\n# Skill\n'
  )
  assert.deepEqual(discoverSkillSources(f.skills), [{ dir: f.skills }])
})

test('duplicate leaf identities in different groups are rejected with both source paths', () => {
  const f = fixture()
  skill(f.skills, 'first/same-skill')
  skill(f.skills, 'second/same-skill')
  assert.throws(() => discoverSkillSources(f.skills), /重复技能.*same-skill.*first.*second/)
})

test('explicit metadata categories win over path categories without inventing flat categories', () => {
  assert.equal(
    skillSourceCategory({ metadata: { category: '  Curated RNA  ' } }, 'biology/rna'),
    'Curated RNA'
  )
  assert.equal(skillSourceCategory({ metadata: { category: '' } }, 'biology/rna'), 'biology/rna')
  assert.equal(skillSourceCategory({ metadata: { category: 10 } }, 'biology/rna'), 'biology/rna')
  assert.equal(
    skillSourceCategory({ metadata: { category: 'bad\ncategory' } }, 'biology/rna'),
    'biology/rna'
  )
  assert.equal(skillSourceCategory({ metadata: {} }), undefined)
  assert.equal(skillSourceCategory(undefined), undefined)
})

for (const location of ['root', 'group', 'manifest', 'resource'] as const) {
  test(`refuses ${location} symbolic links during source discovery`, () => {
    const f = fixture()
    const outside = join(f.root, 'outside')
    mkdirSync(outside)
    if (location === 'root') {
      const alias = join(f.root, 'linked-skills')
      symlinkSync(f.skills, alias)
      assert.throws(() => discoverSkillSources(alias), /符号链接/)
      return
    }
    if (location === 'group') symlinkSync(outside, join(f.skills, 'linked-group'))
    if (location === 'manifest') {
      const directory = join(f.skills, 'linked-skill')
      mkdirSync(directory)
      writeFileSync(join(outside, 'SKILL.md'), 'outside')
      symlinkSync(join(outside, 'SKILL.md'), join(directory, 'SKILL.md'))
    }
    if (location === 'resource') {
      const directory = skill(f.skills, 'group/safe-skill')
      symlinkSync(outside, join(directory, 'references'))
    }
    assert.throws(() => discoverSkillSources(f.skills), /符号链接/)
  })
}

test('missing source roots remain empty and excessive nested directory depths fail explicitly', () => {
  const f = fixture()
  assert.deepEqual(discoverSkillSources(join(f.root, 'missing')), [])
  skill(f.skills, `${Array(20).fill('group').join('/')}/deep-skill`)
  assert.throws(() => discoverSkillSources(f.skills), /深度/)
})
