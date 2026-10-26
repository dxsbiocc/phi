import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

const execFileAsync = promisify(execFile)

test('kernel specialists inherit max thinking and the parent environment binding', async () => {
  const moduleUrl = pathToFileURL(resolve('src/main/agent/engine/in-process/subagents.ts')).href
  const script = `
    import {
      resolveSpecialistEnvironmentBinding,
      specialistThinkingLevel
    } from ${JSON.stringify(moduleUrl)}
    const definition = {
      name: 'PlanStep',
      description: 'Executes a plan step.',
      tools: ['read'],
      skills: [],
      invocation: 'host',
      visibility: 'entry',
      warnings: [],
      systemPrompt: 'Execute the step.',
      source: 'phi',
      filePath: '/agents/PlanStep.md'
    }
    const environment = {
      ref: 'env://project',
      variables: { PHI_ENV_PREFIX: '/managed/project' }
    }
    const inherited = await resolveSpecialistEnvironmentBinding(
      definition,
      { sessionId: 'session-1', cwd: '/project' },
      environment
    )
    console.log(JSON.stringify({
      thinking: specialistThinkingLevel(definition, 'max'),
      sameEnvironment: inherited === environment
    }))
  `
  const { stdout } = await execFileAsync(resolveBunExecutable(), ['--eval', script], {
    cwd: resolve('.'),
    timeout: 15_000
  })
  assert.deepEqual(JSON.parse(stdout.trim()), {
    thinking: 'max',
    sameEnvironment: true
  })
})
