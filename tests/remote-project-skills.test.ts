import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  discoverRemoteProjectSkills,
  MAX_REMOTE_PROJECT_SKILL_DEPTH,
  MAX_REMOTE_PROJECT_SKILL_DIRECTORY_ENTRIES,
  MAX_REMOTE_PROJECT_SKILL_FILE_BYTES
} from '../src/main/agent/content/remote-project-skill-discovery'
import { trustRemoteProjectAgent } from '../src/main/agent/agents/remote-agent-trust-store'
import { createRemoteRuntimeFixture } from './helpers/remoteRuntimeFixture'

function skillMarkdown(name: string): string {
  return `---
name: ${name}
description: ${name} server project skill.
---
Use the remote project files.
`
}

function executableSkillMarkdown(name: string): string {
  return `---
name: ${name}
description: ${name} server project skill.
phi:
  environment: phi:python@1
  toolPrefix: remoteview
  scripts:
    - name: inspect
      description: Inspect one remote input.
      run: [bash, ./scripts/run.sh]
      args:
        type: object
        additionalProperties: false
        properties: {}
      approval: read
---
Use the remote project files.
`
}

test('server project skills are visible while pending trust but are not executable sources', async () => {
  const fixture = createRemoteRuntimeFixture()
  const agentDir = join(fixture.root, 'local-phi')
  try {
    const skillDir = join(fixture.projectRoot, '.phi', 'skills', 'remote-review')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), skillMarkdown('remote-review'))

    const result = await discoverRemoteProjectSkills({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir
    })

    assert.deepEqual(result.sources, [])
    assert.deepEqual(
      result.entries.map((entry) => ({
        name: entry.name,
        relativePath: entry.relativePath,
        trustState: entry.trustState,
        available: entry.available
      })),
      [
        {
          name: 'remote-review',
          relativePath: '.phi/skills/remote-review/SKILL.md',
          trustState: 'pending',
          available: false
        }
      ]
    )
    assert.match(result.entries[0]?.content ?? '', /Use the remote project files/)
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('trust covers a stable complete directory snapshot and any bundled file change revokes execution', async () => {
  const fixture = createRemoteRuntimeFixture()
  const agentDir = join(fixture.root, 'local-phi')
  const relativePath = '.omp/skills/remote-view/SKILL.md'
  const skillDir = join(fixture.projectRoot, '.omp', 'skills', 'remote-view')
  try {
    mkdirSync(join(skillDir, 'scripts'), { recursive: true })
    mkdirSync(join(skillDir, 'assets'), { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), executableSkillMarkdown('remote-view'))
    writeFileSync(join(skillDir, 'scripts', 'run.sh'), '#!/bin/sh\nprintf ok\n')
    writeFileSync(join(skillDir, 'assets', 'binary.bin'), Buffer.from([0, 255, 1, 2]))

    const pending = await discoverRemoteProjectSkills({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir
    })
    const originalHash = pending.entries[0]?.contentHash ?? ''
    trustRemoteProjectAgent(
      {
        hostAlias: 'fake-lab',
        projectRoot: fixture.projectRoot,
        relativePath,
        contentHash: originalHash
      },
      agentDir
    )

    const trusted = await discoverRemoteProjectSkills({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir
    })
    assert.equal(trusted.entries[0]?.trustState, 'trusted')
    assert.deepEqual(
      trusted.sources.map((source) => ({
        name: source.name,
        filePath: source.filePath,
        dir: source.dir,
        insidePlugin: source.insidePlugin,
        remoteProject: source.remoteProject,
        files: source.files.map((file) => ({
          relativePath: file.relativePath,
          content: [...file.content],
          executable: file.executable
        }))
      })),
      [
        {
          name: 'remote-view',
          filePath: relativePath,
          dir: '.omp/skills/remote-view',
          insidePlugin: false,
          remoteProject: true,
          files: [
            {
              relativePath: 'SKILL.md',
              content: [...Buffer.from(executableSkillMarkdown('remote-view'))],
              executable: false
            },
            {
              relativePath: 'assets/binary.bin',
              content: [0, 255, 1, 2],
              executable: false
            },
            {
              relativePath: 'scripts/run.sh',
              content: [...Buffer.from('#!/bin/sh\nprintf ok\n')],
              executable: true
            }
          ]
        }
      ]
    )

    writeFileSync(join(skillDir, 'assets', 'binary.bin'), Buffer.from([0, 255, 1, 3]))
    const changed = await discoverRemoteProjectSkills({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir
    })
    assert.equal(changed.entries[0]?.trustState, 'changed')
    assert.notEqual(changed.entries[0]?.contentHash, originalHash)
    assert.deepEqual(changed.sources, [])
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('binary SKILL.md is visible as invalid but never becomes an executable source', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const skillDir = join(fixture.projectRoot, '.pi', 'skills', 'binary-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), Buffer.from([0, 255, 1, 2]))

    const result = await discoverRemoteProjectSkills({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir: join(fixture.root, 'local-phi')
    })

    assert.deepEqual(result.sources, [])
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0]?.name, 'binary-skill')
    assert.equal(result.entries[0]?.trustState, 'invalid')
    assert.equal(result.entries[0]?.available, false)
    assert.equal(result.entries[0]?.content, '')
    assert.match(result.entries[0]?.diagnostics.join('\n') ?? '', /二进制/)
    assert.match(result.entries[0]?.contentHash ?? '', /^[a-f0-9]{64}$/)
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('skill discovery never follows a bundled symlink outside the canonical project root', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const skillDir = join(fixture.projectRoot, '.phi', 'skills', 'escape-skill')
    const outside = join(fixture.root, 'outside-secret.bin')
    mkdirSync(join(skillDir, 'assets'), { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), skillMarkdown('escape-skill'))
    writeFileSync(outside, 'TOP-SECRET-CONTENT')
    symlinkSync(outside, join(skillDir, 'assets', 'secret.bin'))

    const result = await discoverRemoteProjectSkills({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir: join(fixture.root, 'local-phi')
    })

    assert.deepEqual(result.entries, [])
    assert.deepEqual(result.sources, [])
    assert.equal(JSON.stringify(result).includes('TOP-SECRET-CONTENT'), false)
    assert.match(result.diagnostics.map((item) => item.filePath).join('\n'), /escape-skill/)
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('the committed validateSkill contract rejects an invalid server skill without blocking peers', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const root = join(fixture.projectRoot, '.phi', 'skills')
    mkdirSync(join(root, 'broken'), { recursive: true })
    mkdirSync(join(root, 'valid-peer'), { recursive: true })
    writeFileSync(
      join(root, 'broken', 'SKILL.md'),
      '---\nname: wrong-directory-name\ndescription: Broken.\n---\nBroken.\n'
    )
    writeFileSync(join(root, 'valid-peer', 'SKILL.md'), skillMarkdown('valid-peer'))

    const result = await discoverRemoteProjectSkills({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir: join(fixture.root, 'local-phi')
    })

    assert.equal(result.entries.find((entry) => entry.name === 'broken')?.trustState, 'invalid')
    assert.match(
      result.entries.find((entry) => entry.name === 'broken')?.diagnostics.join('\n') ?? '',
      /must equal package id 'broken'/
    )
    assert.equal(result.entries.find((entry) => entry.name === 'valid-peer')?.trustState, 'pending')
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('one over-limit skill directory is bounded without blocking a peer skill', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const root = join(fixture.projectRoot, '.phi', 'skills')
    const crowded = join(root, 'crowded')
    const peer = join(root, 'peer')
    mkdirSync(crowded, { recursive: true })
    mkdirSync(peer, { recursive: true })
    writeFileSync(join(peer, 'SKILL.md'), skillMarkdown('peer'))
    for (let index = 0; index <= MAX_REMOTE_PROJECT_SKILL_DIRECTORY_ENTRIES; index += 1) {
      writeFileSync(join(crowded, `asset-${index}.txt`), '')
    }

    const result = await discoverRemoteProjectSkills({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir: join(fixture.root, 'local-phi')
    })

    assert.deepEqual(
      result.entries.map((entry) => entry.name),
      ['peer']
    )
    assert.match(
      result.diagnostics.map((item) => item.message).join('\n'),
      new RegExp(`${MAX_REMOTE_PROJECT_SKILL_DIRECTORY_ENTRIES}.*上限`)
    )
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('an oversized bundled file is rejected before it can enter a trusted snapshot', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const skillDir = join(fixture.projectRoot, '.pi', 'skills', 'large-resource')
    mkdirSync(join(skillDir, 'assets'), { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), skillMarkdown('large-resource'))
    writeFileSync(
      join(skillDir, 'assets', 'large.bin'),
      Buffer.alloc(MAX_REMOTE_PROJECT_SKILL_FILE_BYTES + 1, 1)
    )

    const result = await discoverRemoteProjectSkills({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir: join(fixture.root, 'local-phi')
    })

    assert.deepEqual(result.entries, [])
    assert.deepEqual(result.sources, [])
    assert.match(result.diagnostics.map((item) => item.message).join('\n'), /单文件上限/)
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('skill resource traversal stops at the exported depth limit', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const skillDir = join(fixture.projectRoot, '.omp', 'skills', 'too-deep')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), skillMarkdown('too-deep'))
    let nested = skillDir
    for (let depth = 0; depth <= MAX_REMOTE_PROJECT_SKILL_DEPTH; depth += 1) {
      nested = join(nested, `level-${depth}`)
      mkdirSync(nested)
    }
    writeFileSync(join(nested, 'asset.txt'), 'too deep')

    const result = await discoverRemoteProjectSkills({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir: join(fixture.root, 'local-phi')
    })

    assert.deepEqual(result.entries, [])
    assert.match(
      result.diagnostics.map((item) => item.message).join('\n'),
      new RegExp(`深度超过 ${MAX_REMOTE_PROJECT_SKILL_DEPTH} 层上限`)
    )
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})
