import assert from 'node:assert/strict'
import test from 'node:test'

import { createMissingToolPrompt } from '../src/main/agent/host-requests/missing-tool-prompt'

const nextflowPrompt = {
  runtimeSessionId: 'runtime-1',
  tool: { id: 'nextflow' as const, label: 'Nextflow' },
  candidates: [
    {
      path: '/data/user/miniconda3/envs/nextflow/bin/nextflow',
      source: 'conda' as const,
      version: '25.04.7'
    }
  ],
  install: {
    environment: 'phi-nextflow',
    location: '/data/user/.phi/runtime/envs',
    packages: ['nextflow', 'openjdk>=17'],
    approximateSize: 'about 350 MiB download'
  }
}

test('missing-tool prompt returns the selected candidate path without installing', async () => {
  const requests: unknown[] = []
  const prompt = createMissingToolPrompt({
    request: async (request) => {
      requests.push(request)
      return {
        requestId: 'interaction-1',
        answers: [],
        missingToolChoice: {
          action: 'candidate',
          path: '/data/user/miniconda3/envs/nextflow/bin/nextflow'
        }
      }
    }
  })

  const choice = await prompt(nextflowPrompt)

  assert.deepEqual(choice, {
    action: 'path',
    path: '/data/user/miniconda3/envs/nextflow/bin/nextflow'
  })
  assert.deepEqual(requests, [
    {
      runtimeSessionId: 'runtime-1',
      questions: [
        {
          header: 'Tool',
          question: 'Nextflow is required before this call can continue.',
          options: [
            { label: 'Enter a path', description: 'Choose an executable or environment folder.' },
            {
              label: 'Install',
              description: 'Create the Phi-managed phi-nextflow environment.'
            },
            { label: 'Cancel', description: 'Stop this call without changing the host.' }
          ]
        }
      ],
      missingTool: nextflowPrompt
    }
  ])
})

test('missing-tool prompt installs only after an explicit install choice', async () => {
  let calls = 0
  const prompt = createMissingToolPrompt({
    request: async () => {
      calls += 1
      return {
        requestId: 'interaction-2',
        answers: [],
        missingToolChoice: { action: 'install' }
      }
    }
  })

  assert.deepEqual(await prompt(nextflowPrompt), { action: 'install' })
  assert.equal(calls, 1)
})

test('missing-tool prompt cancellation stays blocked and path-only tools omit install', async () => {
  let request: Record<string, unknown> | undefined
  const prompt = createMissingToolPrompt({
    request: async (value) => {
      request = value as Record<string, unknown>
      return { requestId: 'interaction-3', answers: [], cancelled: true }
    }
  })

  const choice = await prompt({
    runtimeSessionId: 'runtime-1',
    tool: { id: 'docker', label: 'Docker' },
    candidates: []
  })

  assert.deepEqual(choice, { action: 'cancel' })
  assert.equal('install' in (request?.missingTool as object), false)
  assert.deepEqual((request?.questions as Array<{ options: unknown }>)[0]?.options, [
    { label: 'Enter a path', description: 'Choose an executable or environment folder.' },
    { label: 'Cancel', description: 'Stop this call without changing the host.' }
  ])
})
