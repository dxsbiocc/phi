import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { loadRemoteWrapperAgent } from '../src/main/agent/agents/remote-wrapper-agent'
import { remoteProjectToolDecision } from '../src/main/agent/agents/remote-project-tool-guard'

test('only bundled Wrapper is enabled for an SSH project with a remote-safe toolbox', () => {
  const definition = loadRemoteWrapperAgent(join(process.cwd(), 'resources', 'agents'))
  assert.ok(definition)
  assert.equal(definition.name, 'Wrapper')
  assert.deepEqual(definition.tools, [
    'read',
    'glob',
    'grep',
    'bash',
    'write',
    'edit',
    'wrapper_search',
    'wrapper_inspect',
    'wrapper_run',
    'wrapper_status',
    'wrapper_wait',
    'wrapper_cancel'
  ])
  assert.deepEqual(definition.skills, [])
  assert.equal(definition.fallback, undefined)
  assert.match(definition.systemPrompt, /selected SSH host/)
  assert.match(definition.systemPrompt, /wrapper_run for remote submission/)
  assert.match(definition.systemPrompt, /Explicit target: local is rejected/)
  assert.match(definition.systemPrompt, /Never launch Nextflow or Slurm through Bash/)
})

test('a missing bundled definition never enables a local or project Wrapper substitute', () => {
  assert.equal(loadRemoteWrapperAgent('/nonexistent-phi-bundled-agents'), undefined)
})

test('remote Wrapper run controls require Phi registration and never expose built-in tools', () => {
  for (const tool of ['wrapper_run', 'wrapper_status', 'wrapper_wait', 'wrapper_cancel']) {
    assert.match(remoteProjectToolDecision(tool)?.reason ?? '', /暂不可用/)
    assert.equal(
      remoteProjectToolDecision(tool, false, false, false, false, false, false, true),
      undefined
    )
  }
  assert.match(
    remoteProjectToolDecision('powershell', false, false, false, false, false, false, true)
      ?.reason ?? '',
    /暂不可用/
  )
})
