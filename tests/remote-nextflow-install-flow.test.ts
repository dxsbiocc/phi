import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  HOST_CAPABILITY_PROBE_SCRIPT,
  parseHostCapabilityProbe
} from '../src/main/agent/workspace-host/probe'
import { installRemoteNextflowAndRefreshProfile } from '../src/renderer/src/features/wrapper/lib/remoteNextflowInstall'
import type { RemoteDoctorReport } from '../src/shared/remoteDoctorTypes'

const refreshedReport: RemoteDoctorReport = {
  hostProfileId: 'host-a',
  checkedAt: '2026-10-09T00:00:00.000Z',
  ok: true,
  checks: [{ id: 'nextflow', status: 'ok', message: '找到 Nextflow' }]
}

test('successful installation invalidates the project capability profile and probes it again', async () => {
  const calls: string[] = []
  const result = await installRemoteNextflowAndRefreshProfile(
    {
      hostProfileId: 'host-a',
      projectRoot: '/cluster/project',
      doctorOptions: {
        scope: 'full',
        scheduler: 'slurm',
        controller: 'login',
        runtime: 'singularity'
      }
    },
    {
      install: async (hostProfileId) => {
        calls.push(`install:${hostProfileId}`)
        return { path: '/home/account/.local/bin/nextflow', alreadyInstalled: false }
      },
      probe: async (hostProfileId, projectRoot, options) => {
        calls.push(`probe:${hostProfileId}:${projectRoot}`)
        assert.deepEqual(options, {
          scope: 'full',
          scheduler: 'slurm',
          controller: 'login',
          runtime: 'singularity',
          nextflowBin: '/home/account/.local/bin/nextflow',
          refreshCapabilities: true
        })
        return refreshedReport
      }
    }
  )

  assert.deepEqual(calls, ['install:host-a', 'probe:host-a:/cluster/project'])
  assert.deepEqual(result, {
    installResult: { path: '/home/account/.local/bin/nextflow', alreadyInstalled: false },
    report: refreshedReport
  })
})

test('the refreshed profile sees an account-local Nextflow outside PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-nextflow-profile-'))
  const installDirectory = join(root, '.local', 'bin')
  const runtimeDirectory = join(root, 'tmp')
  mkdirSync(installDirectory, { recursive: true })
  mkdirSync(runtimeDirectory)
  writeFileSync(
    join(installDirectory, 'nextflow'),
    '#!/bin/sh\necho "nextflow version 25.04.7"\n',
    {
      mode: 0o755
    }
  )
  try {
    const result = spawnSync('/bin/sh', ['-s'], {
      input: HOST_CAPABILITY_PROBE_SCRIPT,
      encoding: 'utf8',
      env: { ...process.env, HOME: root, PATH: '/usr/bin:/bin', TMPDIR: runtimeDirectory },
      timeout: 30_000
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(parseHostCapabilityProbe(result.stdout).toolchain.nextflow, {
      state: 'available',
      version: '25.04.7'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
