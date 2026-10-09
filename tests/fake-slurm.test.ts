import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { installFakeSlurm } from './helpers/fakeSlurm'

function command(name: string, args: string[]): string {
  return execFileSync(name, args, { encoding: 'utf8' }).trim()
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fake Slurm state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function writeJob(path: string, workDir: string, body: string): void {
  writeFileSync(
    path,
    `#!/bin/bash\n#SBATCH --chdir=${workDir}\n#SBATCH --output=${workDir}/stdout.log\n#SBATCH --error=${workDir}/stderr.log\n${body}\n`
  )
}

test('cancelling a controller job leaves its separately submitted task job running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-fake-slurm-test-'))
  const fake = installFakeSlurm(root)
  const runDir = join(root, 'run')
  const taskWorkDir = join(runDir, 'work', 'task-a')
  const receipt = join(runDir, 'task.receipt')
  mkdirSync(taskWorkDir, { recursive: true })
  const taskScript = join(runDir, 'task.sh')
  const controllerScript = join(runDir, 'controller.sh')
  writeJob(taskScript, taskWorkDir, 'while true; do sleep 1; done')
  writeJob(
    controllerScript,
    runDir,
    `sbatch ${JSON.stringify(taskScript)} > ${JSON.stringify(receipt)}\nwhile true; do sleep 1; done`
  )

  let controllerId: string | undefined
  let taskId: string | undefined
  try {
    controllerId = command('sbatch', [controllerScript]).match(/\d+/)?.[0]
    assert.ok(controllerId)
    await waitFor(() => {
      try {
        taskId = readFileSync(receipt, 'utf8').match(/\d+/)?.[0]
        return taskId !== undefined
      } catch {
        return false
      }
    })

    const rows = command('squeue', ['-u', process.env.USER ?? 'tester', '-h', '-o', '%i|%T|%Z'])
    assert.match(rows, new RegExp(`^${controllerId}\\|RUNNING\\|${runDir}`, 'm'))
    assert.match(rows, new RegExp(`^${taskId}\\|RUNNING\\|${taskWorkDir}`, 'm'))
    command('scancel', [controllerId])
    await waitFor(() => command('squeue', ['-h', '-j', controllerId!, '-o', '%T']) === '')
    assert.equal(command('squeue', ['-h', '-j', taskId!, '-o', '%T']), 'RUNNING')
    assert.match(
      command('scontrol', ['show', 'job', taskId!]),
      new RegExp(`WorkDir=${taskWorkDir}`)
    )
  } finally {
    if (controllerId) command('scancel', ['--signal=KILL', controllerId])
    if (taskId) command('scancel', ['--signal=KILL', taskId])
    fake.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('full TERM reaches a cooperative controller which cancels its task job', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-fake-slurm-term-test-'))
  const fake = installFakeSlurm(root)
  const runDir = join(root, 'run')
  const taskWorkDir = join(runDir, 'work', 'task-a')
  const receipt = join(runDir, 'task.receipt')
  mkdirSync(taskWorkDir, { recursive: true })
  const taskScript = join(runDir, 'task.sh')
  const controllerScript = join(runDir, 'controller.sh')
  writeJob(taskScript, taskWorkDir, 'while true; do sleep 1; done')
  writeJob(
    controllerScript,
    runDir,
    `trap 'scancel "$(sed -n "s/.* //p" ${receipt})"; exit 143' TERM\n` +
      `sbatch ${JSON.stringify(taskScript)} > ${JSON.stringify(receipt)}\n` +
      'while true; do sleep 1; done'
  )

  let controllerId: string | undefined
  let taskId: string | undefined
  try {
    controllerId = command('sbatch', [controllerScript]).match(/\d+/)?.[0]
    assert.ok(controllerId)
    await waitFor(() => {
      try {
        taskId = readFileSync(receipt, 'utf8').match(/\d+/)?.[0]
        return taskId !== undefined
      } catch {
        return false
      }
    })
    command('scancel', ['--full', '--signal=TERM', controllerId])
    await waitFor(() => command('squeue', ['-h', '-j', taskId!, '-o', '%T']) === '')
    assert.match(command('scontrol', ['show', 'job', controllerId]), /JobState=CANCELLED/)
    assert.ok(
      fake
        .scancelCalls()
        .some((call) => call.jobId === controllerId && call.full && call.signal === 'TERM')
    )
  } finally {
    if (controllerId) command('scancel', ['--signal=KILL', controllerId])
    if (taskId) command('scancel', ['--signal=KILL', taskId])
    fake.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Slurm 17.11 mode records a full TERM controller as FAILED with signal 15', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-fake-slurm-17-test-'))
  const fake = installFakeSlurm(root)
  const runDir = join(root, 'run')
  mkdirSync(runDir, { recursive: true })
  const controllerScript = join(runDir, 'controller.sh')
  writeJob(controllerScript, runDir, "trap 'exit 143' TERM\nwhile true; do sleep 1; done")

  let controllerId: string | undefined
  try {
    fake.setFullTermBehavior('failed')
    controllerId = command('sbatch', [controllerScript]).match(/\d+/)?.[0]
    assert.ok(controllerId)
    command('scancel', ['--full', '--signal=TERM', controllerId])
    await waitFor(() => command('squeue', ['-h', '-j', controllerId!, '-o', '%T']) === '')
    const detail = command('scontrol', ['show', 'job', controllerId])
    assert.match(detail, /JobState=FAILED/)
    assert.match(detail, /ExitCode=0:15/)
  } finally {
    if (controllerId) command('scancel', ['--signal=KILL', controllerId])
    fake.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('scontrol retains WorkDir when this cluster rejects the squeue %Z format', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-fake-slurm-format-test-'))
  const fake = installFakeSlurm(root)
  const workDir = join(root, 'run', 'work', 'task-a')
  mkdirSync(workDir, { recursive: true })
  const script = join(root, 'task.sh')
  writeJob(script, workDir, 'while true; do sleep 1; done')

  let jobId: string | undefined
  try {
    jobId = command('sbatch', [script]).match(/\d+/)?.[0]
    assert.ok(jobId)
    fake.setSqueueWorkDirSupported(false)
    const queue = spawnSync(
      'squeue',
      ['-u', process.env.USER ?? 'tester', '-h', '-o', '%i|%T|%Z'],
      { encoding: 'utf8' }
    )
    assert.equal(queue.status, 1)
    assert.match(queue.stderr, /Invalid job format specification.*Z/)
    assert.match(command('scontrol', ['show', 'job', jobId]), new RegExp(`WorkDir=${workDir}`))
  } finally {
    if (jobId) command('scancel', ['--signal=KILL', jobId])
    fake.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('an injected unkillable job stays queued and records every cancellation attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-fake-slurm-unkillable-test-'))
  const fake = installFakeSlurm(root)
  const workDir = join(root, 'run', 'work', 'task-a')
  mkdirSync(workDir, { recursive: true })
  const script = join(root, 'task.sh')
  writeJob(script, workDir, 'while true; do sleep 1; done')

  let jobId: string | undefined
  try {
    jobId = command('sbatch', [script]).match(/\d+/)?.[0]
    assert.ok(jobId)
    fake.setUnkillable(jobId, true)
    command('scancel', [jobId])
    assert.equal(command('squeue', ['-h', '-j', jobId, '-o', '%T']), 'RUNNING')
    assert.equal(fake.scancelCalls().filter((call) => call.jobId === jobId).length, 1)
    fake.setUnkillable(jobId, false)
    command('scancel', ['--signal=KILL', jobId])
    await waitFor(() => command('squeue', ['-h', '-j', jobId!, '-o', '%T']) === '')
  } finally {
    if (jobId) {
      fake.setUnkillable(jobId, false)
      command('scancel', ['--signal=KILL', jobId])
    }
    fake.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a TERM-ignoring controller needs hard cancellation and a WorkDir task scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-fake-slurm-ignore-term-test-'))
  const fake = installFakeSlurm(root)
  const runDir = join(root, 'run')
  const taskWorkDir = join(runDir, 'work', 'task-a')
  const receipt = join(runDir, 'task.receipt')
  mkdirSync(taskWorkDir, { recursive: true })
  const taskScript = join(runDir, 'task.sh')
  const controllerScript = join(runDir, 'controller.sh')
  writeJob(taskScript, taskWorkDir, 'while true; do sleep 1; done')
  writeJob(
    controllerScript,
    runDir,
    `trap '' TERM\nsbatch ${JSON.stringify(taskScript)} > ${JSON.stringify(receipt)}\n` +
      'while true; do sleep 1; done'
  )

  let controllerId: string | undefined
  let taskId: string | undefined
  try {
    controllerId = command('sbatch', [controllerScript]).match(/\d+/)?.[0]
    assert.ok(controllerId)
    await waitFor(() => {
      try {
        taskId = readFileSync(receipt, 'utf8').match(/\d+/)?.[0]
        return taskId !== undefined
      } catch {
        return false
      }
    })
    command('scancel', ['--full', '--signal=TERM', controllerId])
    assert.equal(command('squeue', ['-h', '-j', controllerId, '-o', '%T']), 'RUNNING')
    command('scancel', [controllerId])
    await waitFor(() => command('squeue', ['-h', '-j', controllerId!, '-o', '%T']) === '')
    const rows = command('squeue', ['-u', process.env.USER ?? 'tester', '-h', '-o', '%i|%T|%Z'])
    const residual = rows.split('\n').find((row) => row.endsWith(`|${taskWorkDir}`))
    assert.equal(residual?.split('|')[0], taskId)
    command('scancel', [taskId!])
    await waitFor(() => command('squeue', ['-h', '-j', taskId!, '-o', '%T']) === '')
  } finally {
    if (controllerId) command('scancel', ['--signal=KILL', controllerId])
    if (taskId) command('scancel', ['--signal=KILL', taskId])
    fake.restore()
    rmSync(root, { recursive: true, force: true })
  }
})
