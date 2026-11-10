import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  buildRegistry,
  parseChangelogSections,
  type RegistryIndexEntry
} from '../scripts/packages/build-registry'
import { parseRegistryEntry } from '../src/main/agent/packages/registry'

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-package-changelog-'))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  return root
}

function writeSkill(root: string, changelog?: string): void {
  write(
    join(root, 'resources', 'skills', 'alpha-skill', 'SKILL.md'),
    `---
name: alpha-skill
description: Alpha skill fixture.
metadata:
  version: 1.2.0
---

# Alpha skill
`
  )
  if (changelog !== undefined) {
    write(join(root, 'resources', 'skills', 'alpha-skill', 'CHANGELOG.md'), changelog)
  }
  execFileSync('git', ['add', 'resources'], { cwd: root })
}

function build(root: string): RegistryIndexEntry {
  const index = buildRegistry({
    repoRoot: root,
    outDir: join(root, 'registry'),
    generatedAt: '2026-10-02T00:00:00.000Z'
  })
  const entry = index.packages.find(
    (candidate) => candidate.type === 'skill' && candidate.id === 'alpha-skill'
  )
  assert.ok(entry)
  return entry
}

test('parses changelog heading variants and stops at the next level-two heading', () => {
  assert.deepEqual(
    parseChangelogSections(
      `# Changelog

## 0.8.0 - 2025-01-03
Future release.

## v0.7.0
Second release.

### Details
Still part of the second release.

## [0.6.0] (2025-01-01)
First release.
`,
      '0.7.0'
    ),
    [
      {
        version: '0.7.0',
        notes: 'Second release.\n\n### Details\nStill part of the second release.'
      },
      { version: '0.6.0', notes: 'First release.' }
    ]
  )
})

test('keeps at most five sections, newest first, and ignores non-version headings', () => {
  const changelog = [
    '# Changelog',
    '## Unreleased',
    'Not a version.',
    '## 6.0.0',
    'Newer than the manifest.',
    ...['5.0.0', '4.0.0', '3.0.0', '2.0.0', '1.0.0', '0.9.0'].flatMap((version) => [
      `## ${version}`,
      `${version} notes.`
    ])
  ].join('\n')

  assert.deepEqual(
    parseChangelogSections(changelog, '5.0.0').map(({ version }) => version),
    ['5.0.0', '4.0.0', '3.0.0', '2.0.0', '1.0.0']
  )
})

test('caps each section at 4000 characters on a line boundary and the total at 12000', () => {
  const line = 'x'.repeat(100)
  const body = Array.from({ length: 50 }, () => line).join('\n')
  const changelog = ['5.0.0', '4.0.0', '3.0.0', '2.0.0'].flatMap((version) => [
    `## ${version}`,
    body
  ])

  const sections = parseChangelogSections(changelog.join('\n'), '5.0.0')
  assert.equal(sections.length, 3)
  assert.ok(sections.every(({ notes }) => notes.length <= 4000))
  assert.equal(sections.reduce((total, { notes }) => total + notes.length, 0) <= 12000, true)
  for (const { notes } of sections) {
    assert.ok(notes.endsWith('…'))
    assert.ok(notes.slice(0, -1).endsWith(line))
  }
})

test('omits changelog when the package has no changelog file or no usable section', () => {
  const root = temporaryRepository()
  try {
    writeSkill(root)
    assert.equal('changelog' in build(root), false)

    writeSkill(root, '# Changelog\n\n## Unreleased\nNo version heading.\n')
    assert.equal('changelog' in build(root), false)

    writeSkill(
      root,
      `# Changelog

## 1.2.0
Current release notes.

## 1.1.0
Older release notes.
`
    )
    assert.deepEqual(build(root).changelog, [
      { version: '1.2.0', notes: 'Current release notes.' },
      { version: '1.1.0', notes: 'Older release notes.' }
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('drops invalid changelog items without rejecting the registry entry', () => {
  const base = {
    id: 'alpha-skill',
    type: 'skill',
    version: '2.0.0',
    title: 'Alpha skill',
    summary: 'Alpha skill fixture.',
    archive: 'skill-alpha-skill-2.0.0.tar.gz',
    sha256: 'a'.repeat(64),
    size: 10,
    dependsOn: []
  }

  assert.deepEqual(
    parseRegistryEntry(
      {
        ...base,
        changelog: [
          { version: '1.5.0', notes: 'Valid notes.' },
          { version: 'not-semver', notes: 'Bad version.' },
          { version: '1.4.0', notes: '' },
          { version: '1.3.0', notes: 42 },
          { version: '1.2.0', notes: 'x'.repeat(4001) },
          { version: '1.1.0', notes: 'Another valid section.' }
        ]
      },
      0
    ).changelog,
    [
      { version: '1.5.0', notes: 'Valid notes.' },
      { version: '1.1.0', notes: 'Another valid section.' }
    ]
  )

  const invalid = parseRegistryEntry(
    {
      ...base,
      changelog: [{ version: 'nope', notes: '' }, 'not-an-object']
    },
    0
  )
  assert.equal('changelog' in invalid, false)
  assert.equal('changelog' in parseRegistryEntry({ ...base, changelog: 'nope' }, 0), false)
})
