import assert from 'node:assert/strict'
import test from 'node:test'

import { recoverRemoteWrapperTools } from '../src/main/agent/wrappers/missing-tool-recovery'
import type { RemoteDoctorReport } from '../src/shared/remoteDoctorTypes'

function report(
  checks: RemoteDoctorReport['checks'],
  ok = checks.every((check) => check.status !== 'error')
): RemoteDoctorReport {
  return {
    hostProfileId: 'host-1',
    checkedAt: '2026-11-03T00:00:00.000Z',
    ok,
    checks
  }
}

const missingNextflow = report([
  { id: 'nextflow', status: 'error', message: 'Nextflow not found' },
  { id: 'java', status: 'error', message: 'Java not found' },
  { id: 'runtime', status: 'ok', message: 'docker found' }
])
const ready = report([
  { id: 'nextflow', status: 'ok', message: 'Nextflow found' },
  { id: 'java', status: 'ok', message: 'Java found' },
  { id: 'runtime', status: 'ok', message: 'docker found' }
])

test('missing Nextflow path is validated, saved, rechecked, and then the call can continue', async () => {
  const calls: string[] = []
  const result = await recoverRemoteWrapperTools(
    {
      runtimeSessionId: 'runtime-1',
      hostProfileId: 'host-1',
      profile: 'docker',
      report: missingNextflow,
      installLocation: '/cluster/.phi/runtime/envs'
    },
    {
      search: async () => [
        {
          path: '/cluster/conda/envs/nf/bin/nextflow',
          source: 'conda',
          version: '25.04.7'
        }
      ],
      prompt: async (request) => {
        calls.push(`prompt:${request.tool.id}:${request.candidates.length}`)
        return { action: 'path', path: '/cluster/conda/envs/nf' }
      },
      validate: async (tool, path) => {
        calls.push(`validate:${tool}:${path}`)
        return { ok: true, path: '/cluster/conda/envs/nf/bin/nextflow' }
      },
      save: async (tool, path) => {
        calls.push(`save:${tool}:${path}`)
      },
      installNextflow: async () => {
        calls.push('install')
        return '/cluster/.phi/runtime/envs/phi-nextflow/bin/nextflow'
      },
      rerun: async () => {
        calls.push('rerun')
        return ready
      }
    }
  )

  assert.deepEqual(result, { status: 'ready', report: ready })
  assert.deepEqual(calls, [
    'prompt:nextflow:1',
    'validate:nextflow:/cluster/conda/envs/nf',
    'save:nextflow:/cluster/conda/envs/nf/bin/nextflow',
    'rerun'
  ])
})

test('a rejected path asks again with the reason instead of ending the call', async () => {
  const prompts: Array<{ path: string; reason: string } | undefined> = []
  const answers = ['/wrong', '/cluster/conda/envs/nf']
  const result = await recoverRemoteWrapperTools(
    {
      runtimeSessionId: 'runtime-1',
      hostProfileId: 'host-1',
      profile: 'docker',
      report: missingNextflow,
      installLocation: '/cluster/.phi/runtime/envs'
    },
    {
      search: async () => [],
      prompt: async (request) => {
        prompts.push(request.rejectedPath)
        return { action: 'path', path: answers[prompts.length - 1] }
      },
      validate: async (_tool, path) =>
        path === '/wrong'
          ? { ok: false, error: 'not-executable' }
          : { ok: true, path: '/cluster/conda/envs/nf/bin/nextflow' },
      save: async () => undefined,
      installNextflow: async () => '/unexpected',
      rerun: async () => ready
    }
  )

  assert.equal(result.status, 'ready')
  assert.deepEqual(prompts, [undefined, { path: '/wrong', reason: 'not-executable' }])
})

test('Nextflow installs only after the explicit install choice and then rechecks', async () => {
  const calls: string[] = []
  const result = await recoverRemoteWrapperTools(
    {
      runtimeSessionId: 'runtime-1',
      hostProfileId: 'host-1',
      profile: 'docker',
      report: missingNextflow,
      installLocation: '/cluster/.phi/runtime/envs'
    },
    {
      search: async () => [],
      prompt: async (request) => {
        assert.equal(request.install?.environment, 'phi-nextflow')
        assert.deepEqual(request.install?.packages, ['nextflow', 'openjdk>=17'])
        return { action: 'install' }
      },
      validate: async () => ({ ok: false, error: 'invalid-path' }),
      save: async (tool, path) => {
        calls.push(`save:${tool}:${path}`)
      },
      installNextflow: async () => {
        calls.push('install')
        return '/cluster/.phi/runtime/envs/phi-nextflow/bin/nextflow'
      },
      rerun: async () => ready
    }
  )

  assert.equal(result.status, 'ready')
  assert.deepEqual(calls, [
    'install',
    'save:nextflow:/cluster/.phi/runtime/envs/phi-nextflow/bin/nextflow'
  ])
})

test('cancelling missing Nextflow returns blocked and never installs in Auto mode', async () => {
  let installed = false
  let saved = false
  const result = await recoverRemoteWrapperTools(
    {
      runtimeSessionId: 'runtime-1',
      hostProfileId: 'host-1',
      profile: 'docker',
      report: missingNextflow,
      installLocation: '/cluster/.phi/runtime/envs'
    },
    {
      search: async () => [],
      prompt: async () => ({ action: 'cancel' }),
      validate: async () => ({ ok: false, error: 'invalid-path' }),
      save: async () => {
        saved = true
      },
      installNextflow: async () => {
        installed = true
        return '/unexpected'
      },
      rerun: async () => ready
    }
  )

  assert.deepEqual(result, {
    status: 'blocked',
    error: 'Nextflow is missing and the user declined to choose or install it.'
  })
  assert.equal(installed, false)
  assert.equal(saved, false)
})

test('missing container runtime offers path only and saves a validated executable', async () => {
  const missingRuntime = report([
    { id: 'nextflow', status: 'ok', message: 'Nextflow found' },
    { id: 'java', status: 'ok', message: 'Java found' },
    { id: 'runtime', status: 'error', message: 'singularity not found' }
  ])
  const saved: Array<[string, string]> = []
  const result = await recoverRemoteWrapperTools(
    {
      runtimeSessionId: 'runtime-1',
      hostProfileId: 'host-1',
      profile: 'singularity',
      report: missingRuntime,
      installLocation: '/cluster/.phi/runtime/envs'
    },
    {
      search: async () => [
        { path: '/opt/apptainer/bin/apptainer', source: 'common', version: '1.3.0' }
      ],
      prompt: async (request) => {
        assert.equal(request.tool.id, 'singularity')
        assert.equal(request.install, undefined)
        return { action: 'path', path: '/opt/apptainer/bin/apptainer' }
      },
      validate: async () => ({ ok: true, path: '/opt/apptainer/bin/apptainer' }),
      save: async (tool, path) => {
        saved.push([tool, path])
      },
      installNextflow: async () => {
        throw new Error('container installation must not be offered')
      },
      rerun: async () => ready
    }
  )

  assert.equal(result.status, 'ready')
  assert.deepEqual(saved, [['singularity', '/opt/apptainer/bin/apptainer']])
})
