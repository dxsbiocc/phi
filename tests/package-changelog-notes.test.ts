import assert from 'node:assert/strict'
import test from 'node:test'

import { parsePackageChangelogNotes } from '../src/renderer/src/lib/packageChangelog'

test('splits the real literature-library changelog shape into typed changes and details', () => {
  const notes = `This release focuses on the literature-library workflow.

### Layout

| Area | Change |
| --- | --- |
| Search | Results now group by source |

### Added

- Added **PubMed** search support.
- New \`library\` command for batch imports.

### Removed

- Removed the legacy \`--no-aliases\` flag.`

  assert.deepEqual(parsePackageChangelogNotes(notes), {
    changes: [
      { type: 'new', text: 'Added **PubMed** search support.' },
      { type: 'new', text: 'New `library` command for batch imports.' },
      { type: 'breaking', text: 'Removed the legacy `--no-aliases` flag.' }
    ],
    otherNotes: `This release focuses on the literature-library workflow.

### Layout

| Area | Change |
| --- | --- |
| Search | Results now group by source |`,
    breaking: true
  })
})

test('maps English and Chinese headings case-insensitively', () => {
  const { changes } = parsePackageChangelogNotes(`### aDdEd
- One.

### Features
- Two.

### Changed
- Three.

### 优化
- 四。

### Bug Fixes
- Five.

### 修复
- 六。

### Deprecated
- Seven.

### 不兼容
- 八。`)

  assert.deepEqual(
    changes.map(({ type, text }) => [type, text]),
    [
      ['new', 'One.'],
      ['new', 'Two.'],
      ['improved', 'Three.'],
      ['improved', '四。'],
      ['fixed', 'Five.'],
      ['fixed', '六。'],
      ['breaking', 'Seven.'],
      ['breaking', '八。']
    ]
  )
})

test('joins wrapped bullet lines but keeps nested lists and tables out of typed changes', () => {
  const parsed = parsePackageChangelogNotes(`### Added

- Added **bold** support
  for \`code\` and [links](https://example.com).

- *Another* top-level item
  - A nested detail
  - Another nested detail`)

  assert.deepEqual(parsed.changes, [
    {
      type: 'new',
      text: 'Added **bold** support for `code` and [links](https://example.com).'
    },
    { type: 'new', text: '*Another* top-level item' }
  ])
  assert.match(parsed.otherNotes, /- A nested detail/)
  assert.match(parsed.otherNotes, / {2}- Another nested detail/)
  assert.equal(parsed.breaking, false)
})

test('a changelog with no headings has no typed changes and keeps its markdown', () => {
  const notes = `- Added a feature.
- Fixed a bug.`
  assert.deepEqual(parsePackageChangelogNotes(notes), {
    changes: [],
    otherNotes: notes,
    breaking: false
  })
})

test('a version is breaking from a typed change or from its intro text', () => {
  assert.equal(
    parsePackageChangelogNotes('Intro.\n\n### Removed\n- Dropped the old flag.').breaking,
    true
  )
  assert.equal(
    parsePackageChangelogNotes('This is a **breaking** release.\n\n### Added\n- More.').breaking,
    true
  )
  assert.equal(
    parsePackageChangelogNotes('This release keeps no aliases for the old setting.').breaking,
    true
  )
  assert.equal(parsePackageChangelogNotes('本次更新不兼容旧版本。').breaking, true)
  assert.equal(parsePackageChangelogNotes('Routine release.\n\n### Added\n- More.').breaking, false)
})
