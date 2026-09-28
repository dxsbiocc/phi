import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EMPTY_HPC_DRAFT,
  hpcDraftError,
  hpcDraftFromSettings,
  hpcSettingsFromDraft
} from '../src/renderer/src/features/wrapper/lib/remoteHpcDraft'

test('a new connection starts as slurm with singularity, head process on the login node', () => {
  assert.equal(EMPTY_HPC_DRAFT.controller, 'login')
  assert.equal(EMPTY_HPC_DRAFT.scheduler, 'slurm')
  assert.equal(EMPTY_HPC_DRAFT.runtime, 'singularity')
})

test('an existing connection with no HPC block opens with the defaults', () => {
  assert.deepEqual(hpcDraftFromSettings(undefined), EMPTY_HPC_DRAFT)
})

test('settings survive a round trip through the draft', () => {
  const settings = {
    scheduler: 'slurm' as const,
    runtime: 'conda' as const,
    queue: 'cpu',
    account: 'lab1',
    clusterOptions: '--qos=normal',
    queueSize: 30,
    singularityCacheDir: '/shared/sif',
    nextflowBin: '/opt/nf/nextflow',
    controller: 'sbatch' as const,
    controllerOptions: '--time=7-00:00:00 --mem=8G',
    setupCommands: ['module load java', 'module load nextflow']
  }
  assert.deepEqual(hpcSettingsFromDraft(hpcDraftFromSettings(settings)), settings)
})

test('empty fields are left out of the saved settings instead of stored as empty strings', () => {
  const saved = hpcSettingsFromDraft({ ...EMPTY_HPC_DRAFT, queue: '  ', setupText: '\n  \n' })
  assert.deepEqual(saved, { scheduler: 'slurm', runtime: 'singularity', controller: 'login' })
})

test('setup text becomes one command per non-empty line, trimmed', () => {
  const saved = hpcSettingsFromDraft({
    ...EMPTY_HPC_DRAFT,
    setupText: '  module load java \n\nmodule load nextflow\n'
  })
  assert.deepEqual(saved.setupCommands, ['module load java', 'module load nextflow'])
})

test('slurm-only fields are dropped when the scheduler is local', () => {
  const saved = hpcSettingsFromDraft({
    ...EMPTY_HPC_DRAFT,
    scheduler: 'local',
    queue: 'cpu',
    account: 'a',
    clusterOptions: '--x',
    queueSize: '10'
  })
  assert.equal(saved.queue, undefined)
  assert.equal(saved.account, undefined)
  assert.equal(saved.clusterOptions, undefined)
  assert.equal(saved.queueSize, undefined)
})

test('queue size must be a positive whole number', () => {
  assert.equal(hpcDraftError({ ...EMPTY_HPC_DRAFT, queueSize: '20' }), null)
  assert.equal(hpcDraftError({ ...EMPTY_HPC_DRAFT, queueSize: '' }), null)
  assert.match(hpcDraftError({ ...EMPTY_HPC_DRAFT, queueSize: 'abc' }) ?? '', /排队/)
  assert.match(hpcDraftError({ ...EMPTY_HPC_DRAFT, queueSize: '0' }) ?? '', /排队/)
  assert.match(hpcDraftError({ ...EMPTY_HPC_DRAFT, queueSize: '2.5' }) ?? '', /排队/)
})

test('direct server execution cannot submit the Nextflow head as a Slurm job', () => {
  assert.match(
    hpcDraftError({ ...EMPTY_HPC_DRAFT, scheduler: 'local', controller: 'sbatch' }) ?? '',
    /不能提交为 Slurm 作业/
  )
})

test('cache dir and nextflow path must be absolute when given', () => {
  assert.match(
    hpcDraftError({ ...EMPTY_HPC_DRAFT, singularityCacheDir: 'relative/dir' }) ?? '',
    /绝对路径/
  )
  assert.match(hpcDraftError({ ...EMPTY_HPC_DRAFT, nextflowBin: 'nextflow' }) ?? '', /绝对路径/)
  assert.equal(hpcDraftError({ ...EMPTY_HPC_DRAFT, singularityCacheDir: '/shared/sif' }), null)
})

test('head-job options are only saved when the head process is a Slurm job', () => {
  const login = hpcSettingsFromDraft({
    ...EMPTY_HPC_DRAFT,
    controller: 'login',
    controllerOptions: '--time=1-00:00:00'
  })
  assert.equal(login.controllerOptions, undefined)
  const sbatch = hpcSettingsFromDraft({
    ...EMPTY_HPC_DRAFT,
    controller: 'sbatch',
    controllerOptions: ' --time=1-00:00:00 '
  })
  assert.equal(sbatch.controllerOptions, '--time=1-00:00:00')
})

test('head-job options must be sbatch flags', () => {
  const draft = { ...EMPTY_HPC_DRAFT, controller: 'sbatch' as const }
  assert.equal(hpcDraftError({ ...draft, controllerOptions: '--time=1-00:00:00 --qos long' }), null)
  assert.match(hpcDraftError({ ...draft, controllerOptions: 'time=1-00' }) ?? '', /以 - 开头/)
})

test('the connection-level Nextflow config round-trips and blank text is not saved', () => {
  const config = "process.conda = '/shared/envs/rnaseq'\nsingularity.runOptions = '-B /data'"
  const saved = hpcSettingsFromDraft({ ...EMPTY_HPC_DRAFT, nextflowConfig: `\n${config}\n\n` })
  assert.equal(saved.nextflowConfig, config)
  assert.equal(hpcDraftFromSettings(saved).nextflowConfig, config)
  assert.equal(
    'nextflowConfig' in hpcSettingsFromDraft({ ...EMPTY_HPC_DRAFT, nextflowConfig: '  \n ' }),
    false
  )
})
