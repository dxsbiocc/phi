import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isEnabled } from '../src/main/agent/enablement'
import {
  importHomeSkills,
  listHomeSkillImportCandidates
} from '../src/main/agent/packages/home-skill-import'
import { listInstalledPackages } from '../src/main/agent/packages/installed'

function skillText(name: string, description = `Skill ${name}`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nBody.\n`
}

function writeSkill(root: string, id: string, description?: string): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillText(id, description), 'utf8')
  return dir
}

function withHomes(
  run: (paths: { home: string; agentDir: string }) => Promise<void> | void
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-home-skill-import-'))
  const home = join(root, 'home')
  const agentDir = join(root, 'agent')
  mkdirSync(home, { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  return Promise.resolve(run({ home, agentDir })).finally(() => {
    rmSync(root, { recursive: true, force: true })
  })
}

test('lists discoverable home skills and prefers ~/.agents over ~/.agent', async () => {
  await withHomes(({ home, agentDir }) => {
    writeSkill(join(home, '.agents', 'skills'), 'shared-skill', 'From agents')
    writeSkill(join(home, '.agent', 'skills'), 'shared-skill', 'From agent')
    writeSkill(join(home, '.agent', 'skills'), 'legacy-only', 'Only agent')
    writeSkill(join(home, '.claude', 'skills'), 'claude-skill')
    writeSkill(join(home, '.codex', 'skills'), 'codex-skill')
    writeSkill(join(home, '.cursor', 'skills'), 'cursor-skill')
    mkdirSync(join(home, '.agents', 'skills', 'symlink-skill'), { recursive: true })
    symlinkSync(
      join(home, '.agents', 'skills', 'shared-skill', 'SKILL.md'),
      join(home, '.agents', 'skills', 'broken-link')
    )

    const listed = listHomeSkillImportCandidates({ agentDir, homeDir: home })
    assert.deepEqual(
      listed.sources.map((item) => ({
        source: item.source,
        present: item.present,
        count: item.count
      })),
      [
        { source: 'agents', present: true, count: 2 },
        { source: 'claude', present: true, count: 1 },
        { source: 'codex', present: true, count: 1 },
        { source: 'cursor', present: true, count: 1 }
      ]
    )
    const shared = listed.candidates.find((item) => item.id === 'shared-skill')
    assert.ok(shared)
    assert.equal(shared.source, 'agents')
    assert.match(shared.summary, /From agents/)
    assert.ok(listed.candidates.some((item) => item.id === 'legacy-only'))
    assert.ok(listed.candidates.every((item) => item.id !== 'broken-link'))
  })
})

test('marks missing home roots and skips skill symlinks', async () => {
  await withHomes(({ home, agentDir }) => {
    const cursorSkills = join(home, '.cursor', 'skills')
    writeSkill(cursorSkills, 'real-skill')
    mkdirSync(join(home, 'outside-skill'), { recursive: true })
    writeFileSync(join(home, 'outside-skill', 'SKILL.md'), skillText('escape-skill'), 'utf8')
    symlinkSync(join(home, 'outside-skill'), join(cursorSkills, 'escape-skill'))

    const listed = listHomeSkillImportCandidates({ agentDir, homeDir: home })
    assert.deepEqual(
      listed.sources.filter((item) => !item.present).map((item) => item.source),
      ['agents', 'claude', 'codex']
    )
    assert.equal(listed.sources.find((item) => item.source === 'cursor')?.count, 1)
    assert.ok(listed.candidates.every((item) => item.id !== 'escape-skill'))
  })
})

test('imports selected home skills into Phi packages', async () => {
  await withHomes(async ({ home, agentDir }) => {
    writeSkill(join(home, '.cursor', 'skills'), 'import-me', 'Cursor imported skill')
    writeSkill(join(home, '.claude', 'skills'), 'also-import', 'Claude imported skill')

    const first = await importHomeSkills(
      [
        { source: 'cursor', id: 'import-me' },
        { source: 'claude', id: 'also-import' }
      ],
      { agentDir, appVersion: '0.1.0', homeDir: home }
    )
    assert.deepEqual(first.imported.sort(), ['also-import', 'import-me'])
    assert.deepEqual(first.skipped, [])
    assert.deepEqual(first.errors, [])

    const installed = listInstalledPackages({ agentDir }).filter((item) => item.type === 'skill')
    assert.equal(installed.length, 2)
    for (const item of installed) {
      assert.equal(item.trust, 'imported')
      assert.ok(existsSync(join(item.dir, 'SKILL.md')))
      assert.ok(
        isEnabled(
          { key: `skill:${item.id}`, source: 'installed-package' },
          { agentDir, logger: { info: (): void => undefined, warn: (): void => undefined } }
        )
      )
    }
    assert.match(
      readFileSync(
        join(installed.find((item) => item.id === 'import-me')!.dir, 'SKILL.md'),
        'utf8'
      ),
      /Cursor imported skill/
    )

    const second = await importHomeSkills([{ source: 'cursor', id: 'import-me' }], {
      agentDir,
      appVersion: '0.1.0',
      homeDir: home
    })
    assert.deepEqual(second.imported, [])
    assert.deepEqual(second.skipped, ['import-me'])
    assert.equal(
      listInstalledPackages({ agentDir }).filter((item) => item.type === 'skill').length,
      2
    )

    const listed = listHomeSkillImportCandidates({ agentDir, homeDir: home })
    assert.ok(listed.candidates.every((item) => item.installed))
  })
})

test('same-batch duplicate skill ids import once and skip the rest', async () => {
  await withHomes(async ({ home, agentDir }) => {
    writeSkill(join(home, '.cursor', 'skills'), 'shared-id', 'From cursor')
    writeSkill(join(home, '.claude', 'skills'), 'shared-id', 'From claude')

    const result = await importHomeSkills(
      [
        { source: 'cursor', id: 'shared-id' },
        { source: 'claude', id: 'shared-id' }
      ],
      { agentDir, appVersion: '0.1.0', homeDir: home }
    )
    assert.deepEqual(result.imported, ['shared-id'])
    assert.deepEqual(result.skipped, ['shared-id'])
    assert.deepEqual(result.errors, [])
    assert.equal(
      listInstalledPackages({ agentDir }).filter((item) => item.type === 'skill').length,
      1
    )
  })
})
