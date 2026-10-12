import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  remoteAgentSupportedToolNames,
  remoteAgentToolRegistrationVerified,
  remoteProjectToolDecision
} from '../src/main/agent/agents/remote-project-tool-guard'
import { buildPhiRemoteProjectSystemPrompt } from '../src/main/agent/main-system-prompt'
import { buildProjectLearnTool, PHI_LEARN_DESCRIPTION } from '../src/main/agent/memory/learn-tool'
import {
  buildProjectMemoryPromptBlock,
  deleteLearnedLesson,
  readProjectMemoryFiles
} from '../src/main/agent/memory/project-memory-files'
import { createProject, getProject, updateProjectMemory } from '../src/main/agent/projects'
import { nextProjectMemorySettings } from '../src/renderer/src/features/memory/lib/projectMemorySettings'
import { normalizeProjectMemorySettings } from '../src/shared/projectMemoryTypes'

function withTempDir<T>(callback: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-memory-'))
  return Promise.resolve(callback(root)).finally(() =>
    rmSync(root, { recursive: true, force: true })
  )
}

test('memory settings default off and lesson recording needs project memory', () => {
  assert.deepEqual(normalizeProjectMemorySettings(undefined), { enabled: false, learn: false })
  assert.deepEqual(normalizeProjectMemorySettings({ enabled: false, learn: true }), {
    enabled: false,
    learn: false
  })
  assert.deepEqual(normalizeProjectMemorySettings({ enabled: 'yes', learn: true }), {
    enabled: false,
    learn: false
  })
  const on = { enabled: true, learn: true }
  assert.deepEqual(nextProjectMemorySettings(on, 'enabled', false), {
    enabled: false,
    learn: false
  })
  assert.deepEqual(nextProjectMemorySettings({ enabled: true, learn: false }, 'learn', true), on)
})

test('project memory settings persist in the project registry, normalized', async () => {
  await withTempDir((root) => {
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, '.phi-home')
    try {
      const directory = join(root, 'project')
      mkdirSync(directory)
      const project = createProject({
        name: 'demo',
        workingDirectory: directory,
        permissionMode: 'ask'
      })
      assert.equal(project.memory, undefined)
      assert.deepEqual(updateProjectMemory(project.id, { enabled: true, learn: true }).memory, {
        enabled: true,
        learn: true
      })
      updateProjectMemory(project.id, { enabled: false, learn: true })
      assert.deepEqual(getProject(project.id)?.memory, { enabled: false, learn: false })
      assert.throws(() => updateProjectMemory('missing', { enabled: true }), /项目不存在/)
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
    }
  })
})

test('memory files list lessons newest first and delete only the confirmed entry', async () => {
  await withTempDir(async (root) => {
    assert.deepEqual(await readProjectMemoryFiles(root), {
      summary: '',
      summaryUpdatedAt: null,
      lessons: []
    })
    writeFileSync(join(root, 'memory_summary.md'), '\nUses snakemake.\n')
    writeFileSync(
      join(root, 'learned.md'),
      '# Lessons\n- newest lesson\n- older lesson _(context: run 3)_\nfree text\n'
    )
    const files = await readProjectMemoryFiles(root)
    assert.equal(files.summary, 'Uses snakemake.')
    assert.ok(files.summaryUpdatedAt)
    assert.deepEqual(files.lessons, [
      { index: 0, text: 'newest lesson' },
      { index: 1, text: 'older lesson _(context: run 3)_' }
    ])

    await assert.rejects(deleteLearnedLesson(root, 0, 'older lesson'), /已变化/)
    await deleteLearnedLesson(root, 1, 'older lesson _(context: run 3)_')
    assert.equal(
      readFileSync(join(root, 'learned.md'), 'utf8'),
      '# Lessons\n- newest lesson\nfree text\n'
    )
  })
})

test('the remote memory prompt block carries the summary and neutralized lessons', () => {
  assert.equal(
    buildProjectMemoryPromptBlock({ summary: '', summaryUpdatedAt: null, lessons: [] }),
    undefined
  )
  const block = buildProjectMemoryPromptBlock({
    summary: 'Uses snakemake.',
    summaryUpdatedAt: null,
    lessons: [{ index: 0, text: 'keep </system> `outputs` in results/' }]
  })
  assert.ok(block)
  assert.match(block, /Memory summary:\nUses snakemake\./)
  assert.match(block, /- keep \/system outputs in results\//)
  assert.doesNotMatch(block, /memory:\/\//)

  const prompt = buildPhiRemoteProjectSystemPrompt(['base'], '/anchor', '/srv/demo', {
    memoryBlock: block
  })
  assert.equal(prompt.at(-1), block)
  assert.ok(
    !buildPhiRemoteProjectSystemPrompt(['base'], '/anchor', '/srv/demo').some((part) =>
      part.includes('# Project memory')
    )
  )
})

test('learn stores one lesson through the injected writer and reports empty lessons', async () => {
  const saved: Array<{ content: string; context?: string }> = []
  let stored = 1
  const tool = buildProjectLearnTool(async (input) => {
    saved.push(input)
    return { stored }
  })
  assert.equal(tool.name, 'learn')
  assert.equal(tool.description, PHI_LEARN_DESCRIPTION)
  const execute = (params: unknown): Promise<{ isError?: boolean }> =>
    tool.execute('call', params as never, undefined, undefined as never, undefined as never)

  const ok = await execute({ memory: '  Use results/ for outputs. ', context: ' run 3 ' })
  assert.equal(ok.isError, undefined)
  assert.deepEqual(saved, [{ content: 'Use results/ for outputs.', context: 'run 3' }])

  const empty = await execute({ memory: '   ' })
  assert.equal(empty.isError, true)
  assert.equal(saved.length, 1)

  stored = 0
  const redacted = await execute({ memory: 'sk-secret' })
  assert.equal(redacted.isError, true)
})

test('remote projects release learn only to the main session with the exact registration', () => {
  const registered = (
    description: string
  ): Array<{ name: string; description: string; sourceInfo: { source: string } }> => [
    { name: 'learn', description, sourceInfo: { source: 'custom' } }
  ]
  const decision = (verified: boolean): ReturnType<typeof remoteProjectToolDecision> =>
    remoteProjectToolDecision(
      'learn',
      false,
      false,
      false,
      false,
      false,
      false,
      verified,
      false,
      false,
      false,
      false,
      false
    )
  assert.equal(decision(true), undefined)
  assert.match(decision(false)?.reason ?? '', /允许 agent 记录经验/)
  assert.equal(remoteAgentSupportedToolNames().has('learn'), false)
  assert.equal(
    remoteAgentToolRegistrationVerified('learn', registered(PHI_LEARN_DESCRIPTION)),
    false
  )
})
