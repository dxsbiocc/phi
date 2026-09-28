import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  claimRemoteLaunch,
  observeRemoteLaunch,
  REMOTE_JOB_ID_FILE
} from '../src/main/agent/wrappers/remote-launch-claim'
import { createLocalShellSession } from './helpers/localShellSession'

test('a run ID has one atomic claim and existing PID or job ID is read without launching', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-launch-claim-'))
  const first = createLocalShellSession()
  const second = createLocalShellSession()
  const dir = join(root, 'runs', 'wrun_one')
  try {
    assert.deepEqual(await observeRemoteLaunch(first, dir, 'wrun_one', 'detached'), {
      kind: 'unclaimed'
    })
    const claims = await Promise.all([
      claimRemoteLaunch(first, dir, 'wrun_one'),
      claimRemoteLaunch(second, dir, 'wrun_one')
    ])
    assert.deepEqual(claims.sort(), [false, true])
    assert.equal((await observeRemoteLaunch(first, dir, 'wrun_one', 'detached')).kind, 'unknown')
    await first.writeTextFile(join(dir, 'pid'), '1234\n')
    assert.deepEqual(await observeRemoteLaunch(second, dir, 'wrun_one', 'detached'), {
      kind: 'started',
      pid: 1234
    })
    assert.equal((await observeRemoteLaunch(first, dir, 'another-run', 'detached')).kind, 'unknown')

    const slurm = join(root, 'runs', 'wrun_slurm')
    assert.equal(await claimRemoteLaunch(first, slurm, 'wrun_slurm'), true)
    await first.writeTextFile(join(slurm, REMOTE_JOB_ID_FILE), '9501\n')
    assert.deepEqual(await observeRemoteLaunch(second, slurm, 'wrun_slurm', 'sbatch'), {
      kind: 'started',
      jobId: '9501'
    })
  } finally {
    await first.close()
    await second.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a fast exit proves launch even when its PID reply is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-launch-exit-'))
  const session = createLocalShellSession()
  try {
    const dir = join(root, 'runs', 'wrun_fast')
    assert.equal(await claimRemoteLaunch(session, dir, 'wrun_fast'), true)
    await session.writeTextFile(join(dir, 'exit_code'), '0\n')
    assert.deepEqual(await observeRemoteLaunch(session, dir, 'wrun_fast', 'detached'), {
      kind: 'started',
      exitCode: 0
    })
  } finally {
    await session.close()
    rmSync(root, { recursive: true, force: true })
  }
})
