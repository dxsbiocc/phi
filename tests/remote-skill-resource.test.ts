import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readRemoteSkillResource } from '../src/main/agent/content/remote-skill-resource'

test('remote skill reader exposes only loaded skill files without leaking local paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-skill-'))
  const skillDir = join(root, 'agent', 'skills', 'demo')
  mkdirSync(join(skillDir, 'references'), { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '# Demo\n\nUse the safe workflow.\n')
  writeFileSync(join(skillDir, 'references', 'guide.md'), '# Guide\n')
  const skills = [
    {
      name: 'demo',
      filePath: join(skillDir, 'SKILL.md'),
      baseDir: skillDir
    }
  ]
  try {
    const rootResource = readRemoteSkillResource('skill://demo', skills)
    assert.equal(rootResource.kind, 'file')
    assert.match(rootResource.content, /safe workflow/)
    assert.equal(rootResource.path, 'skill://demo')
    assert.doesNotMatch(JSON.stringify(rootResource), new RegExp(root.replaceAll('/', '\\/')))

    const guide = readRemoteSkillResource('skill://demo/references/guide.md', skills)
    assert.equal(guide.kind, 'file')
    assert.equal(guide.content, '# Guide\n')
    const directory = readRemoteSkillResource('skill://demo/references', skills)
    assert.equal(directory.kind, 'directory')
    assert.deepEqual(directory.entries, [{ name: 'guide.md', isDirectory: false }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('remote skill reader rejects unknown, traversal, escaping symlink and binary resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-skill-boundary-'))
  const skillDir = join(root, 'skill')
  mkdirSync(join(skillDir, 'references'), { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '# Demo\n')
  writeFileSync(join(skillDir, 'binary.bin'), Buffer.from([0, 1, 2]))
  const outside = join(root, 'outside.txt')
  writeFileSync(outside, 'outside')
  symlinkSync(outside, join(skillDir, 'references', 'outside.txt'))
  const skills = [{ name: 'demo', filePath: join(skillDir, 'SKILL.md'), baseDir: skillDir }]
  try {
    assert.throws(() => readRemoteSkillResource('skill://unknown', skills), /Unknown skill/)
    assert.throws(
      () => readRemoteSkillResource('skill://demo/%2e%2e/outside.txt', skills),
      /traversal/i
    )
    assert.throws(
      () => readRemoteSkillResource('skill://demo/references/outside.txt', skills),
      /outside the skill root/
    )
    assert.throws(() => readRemoteSkillResource('skill://demo/binary.bin', skills), /binary/)
    assert.throws(() => readRemoteSkillResource('skill://demo', []), /Unknown skill/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('remote project skill resources are resolved by the trusted server reader', async () => {
  const requests: string[] = []
  const result = await readRemoteSkillResource(
    'skill://server-demo/references/guide.md',
    [
      {
        name: 'server-demo',
        filePath: 'ssh://cluster/srv/project/.phi/skills/server-demo/SKILL.md',
        baseDir: 'ssh://cluster/srv/project/.phi/skills/server-demo',
        sourceInfo: { source: 'server-project' }
      }
    ],
    {
      readRemote: async (uri) => {
        requests.push(uri)
        return {
          kind: 'file',
          path: uri,
          content: '# Server guide\n',
          fileSize: 15,
          contentType: 'text/markdown'
        }
      }
    }
  )

  assert.deepEqual(requests, ['skill://server-demo/references/guide.md'])
  assert.equal(result.kind === 'file' ? result.content : undefined, '# Server guide\n')
})
