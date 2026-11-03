import assert from 'node:assert/strict'
import test from 'node:test'

import { capabilityToolchainChecks } from '../src/main/agent/workspace-host/capability-toolchain-checks'
import type { RemoteDoctorCheck } from '../src/shared/remoteDoctorTypes'

test('an absolute Nextflow environment path checks Java from the same environment', async () => {
  const commands = new Map<string, string>()
  const result = await capabilityToolchainChecks({
    options: {
      scheduler: 'local',
      controller: 'login',
      runtime: 'docker',
      nextflowBin: '/data/envs/nextflow/bin/nextflow',
      containerRuntimeBin: '/opt/docker/bin/docker'
    },
    deferTools: false,
    run: async (input): Promise<RemoteDoctorCheck> => {
      commands.set(input.id, input.command)
      return { id: input.id, status: 'ok', message: input.success }
    }
  })

  assert.equal(
    result.every((check) => check.status === 'ok'),
    true
  )
  assert.match(commands.get('java') ?? '', /\/data\/envs\/nextflow\/bin\/java/)
})
