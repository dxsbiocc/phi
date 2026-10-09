import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { localHrefToPath } from '../src/renderer/src/lib/markdownLocalPathReferences'

const skillDir = join(process.cwd(), 'resources', 'skills', 'create-wrapper')
const skillPath = join(skillDir, 'SKILL.md')
const bundledGuidePath = join(skillDir, 'references', 'guide.md')
const retiredProjectGuidePath = join(
  process.cwd(),
  'docs',
  'design',
  'phi-wrapper-agent-composition-design.md'
)

test('create-wrapper bundles its design reference instead of reaching into project docs', () => {
  const skill = readFileSync(skillPath, 'utf8')

  assert.equal(existsSync(bundledGuidePath), true)
  assert.equal(existsSync(retiredProjectGuidePath), false)
  assert.match(skill, /\(references\/guide\.md\)/)
  assert.doesNotMatch(skill, /docs\/design\//)
  assert.doesNotMatch(skill, /\.\.\/\.\.\/\.\.\/docs\//)

  const guide = readFileSync(bundledGuidePath, 'utf8')
  assert.match(guide, /^# Agent-Facing Nextflow Wrappers/m)
  assert.match(guide, /^## 3\. Wrapper Contract/m)
  assert.match(guide, /^## 9\. Phi Agents/m)
  assert.equal(localHrefToPath('references/guide.md', skillDir), bundledGuidePath)
})
