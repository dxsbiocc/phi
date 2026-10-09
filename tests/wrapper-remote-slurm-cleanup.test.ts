import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { cancelRemoteController } from '../src/main/agent/wrappers/remote-cancel'
import { installFakeSlurm, type FakeSlurm } from './helpers/fakeSlurm'
import { createLocalShellSession } from './helpers/localShellSession'

const RUN_ID = 'wrun_cleanup'

function command(name: string, args: string[]): string {
  return execFileSync(name, args, { encoding: 'utf8' }).trim()
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fake Slurm state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function writeJob(path: string, workDir: string, body: string, name?: string): void {
  writeFileSync(
    path,
    [
      '#!/bin/bash',
      ...(name ? [`#SBATCH --job-name=${name}`] : []),
      `#SBATCH --chdir=${workDir}`,
      `#SBATCH --output=${workDir}/stdout.log`,
      `#SBATCH --error=${workDir}/stderr.log`,
      body,
      ''
    ].join('\n')
  )
}

interface FakeRun {
  fake: FakeSlurm
  root: string
  runDir: string
  controllerId: string
  taskId: string
}

async function createRun(cooperative: boolean): Promise<FakeRun> {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-slurm-cleanup-'))
  const fake = installFakeSlurm(root)
  const runDir = join(root, 'wrappers', 'runs', RUN_ID)
  const taskWorkDir = join(runDir, 'work', 'task-a')
  const receipt = join(runDir, 'task.receipt')
  mkdirSync(join(runDir, '.phi-launch-claim'), { recursive: true })
  mkdirSync(taskWorkDir, { recursive: true })
  writeFileSync(join(runDir, '.phi-launch-claim', 'run-id'), `${RUN_ID}\n`)
  const taskScript = join(runDir, 'task.sh')
  const controllerScript = join(runDir, 'controller.sh')
  writeJob(taskScript, taskWorkDir, 'while true; do sleep 1; done')
  const trap = cooperative
    ? `trap 'scancel "$(sed -n "s/.* //p" ${receipt})"; exit 143' TERM`
    : `trap '' TERM`
  writeJob(
    controllerScript,
    runDir,
    `${trap}\nsbatch ${JSON.stringify(taskScript)} > ${JSON.stringify(receipt)}\n` +
      'while true; do sleep 1; done',
    `phi-${RUN_ID}`
  )
  const controllerId = command('sbatch', [controllerScript]).match(/\d+/)?.[0]
  assert.ok(controllerId)
  writeFileSync(join(runDir, 'job_id'), `${controllerId}\n`)
  let taskId: string | undefined
  await waitFor(() => {
    try {
      taskId = readFileSync(receipt, 'utf8').match(/\d+/)?.[0]
      return taskId !== undefined
    } catch {
      return false
    }
  })
  assert.ok(taskId)
  return { fake, root, runDir, controllerId, taskId }
}

function queued(jobId: string): boolean {
  return command('squeue', ['-h', '-j', jobId, '-o', '%T']) === 'RUNNING'
}

function destroyRun(run: FakeRun, extraJobIds: string[] = []): void {
  run.fake.setUnkillable(run.taskId, false)
  for (const jobId of [run.controllerId, run.taskId, ...extraJobIds]) {
    command('scancel', ['--signal=KILL', jobId])
  }
  run.fake.restore()
  rmSync(run.root, { recursive: true, force: true })
}

async function cancel(
  run: FakeRun,
  graceMs: number
): Promise<{
  result: Awaited<ReturnType<typeof cancelRemoteController>>
  commands: string[]
}> {
  const session = createLocalShellSession(run.root)
  const result = await cancelRemoteController(
    session,
    { runId: RUN_ID, remoteRunDir: run.runDir, jobId: run.controllerId },
    graceMs,
    { cleanupSlurmJobs: true, scanAttempts: 2, scanIntervalMs: 0 }
  )
  return { result, commands: session.commands }
}

test('cooperative Nextflow receives full TERM and cancels its Slurm task', async () => {
  const run = await createRun(true)
  try {
    const { result } = await cancel(run, 2_000)
    assert.equal(result.kind, 'confirmed')
    assert.equal(queued(run.taskId), false)
    assert.ok(
      run.fake
        .scancelCalls()
        .some((call) => call.jobId === run.controllerId && call.full && call.signal === 'TERM')
    )
  } finally {
    destroyRun(run)
  }
})

test('stubborn Nextflow falls back to WorkDir cleanup without touching sibling jobs', async () => {
  const run = await createRun(false)
  const workOther = join(run.runDir, 'work-other', 'task')
  const otherRun = join(run.root, 'wrappers', 'runs', 'wrun_other', 'work', 'task')
  const manual = join(run.root, 'manual-job')
  const extraJobIds = [workOther, otherRun, manual].map((workDir, index) => {
    mkdirSync(workDir, { recursive: true })
    const script = join(run.root, `extra-${index}.sh`)
    writeJob(script, workDir, 'while true; do sleep 1; done')
    const jobId = command('sbatch', [script]).match(/\d+/)?.[0]
    assert.ok(jobId)
    return jobId
  })
  try {
    const { result } = await cancel(run, 0)
    assert.equal(result.kind, 'confirmed')
    assert.equal(queued(run.taskId), false)
    assert.deepEqual(extraJobIds.map(queued), [true, true, true])
  } finally {
    destroyRun(run, extraJobIds)
  }
})

test('residual Slurm task IDs are returned when WorkDir cleanup cannot stop them', async () => {
  const run = await createRun(false)
  run.fake.setUnkillable(run.taskId, true)
  try {
    const { result } = await cancel(run, 0)
    assert.equal(result.kind, 'unknown')
    assert.deepEqual(result.remainingJobIds, [run.taskId])
    assert.match(result.message ?? '', new RegExp(run.taskId))
    assert.equal(queued(run.taskId), true)
  } finally {
    destroyRun(run)
  }
})

test('WorkDir cleanup falls back to scontrol when squeue rejects %Z', async () => {
  const run = await createRun(false)
  run.fake.setSqueueWorkDirSupported(false)
  try {
    const { result, commands } = await cancel(run, 0)
    assert.equal(result.kind, 'confirmed')
    assert.equal(queued(run.taskId), false)
    assert.ok(commands.includes(`scontrol show job ${run.taskId} 2>/dev/null`))
  } finally {
    destroyRun(run)
  }
})
