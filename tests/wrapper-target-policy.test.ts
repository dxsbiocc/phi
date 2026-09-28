import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProjectLocation } from '../src/shared/projectLocation'
import type { RemoteDoctorCheck } from '../src/shared/remoteDoctorTypes'
import type { WrapperManifestEngineProfile } from '../src/shared/wrapperManifestTypes'
import {
  chooseWrapperTarget,
  type WrapperRemoteCandidate,
  type WrapperTargetDoctorSnapshot,
  type WrapperTargetPolicyInput
} from '../src/main/agent/wrappers/target-policy'

const localLocation: ProjectLocation = {
  kind: 'local',
  path: '/local/work',
  realPath: '/local/work'
}
const sshLocation: ProjectLocation = {
  kind: 'ssh',
  hostProfileId: 'host-a',
  remoteRoot: '/home/me/project-link',
  canonicalRoot: '/data/project'
}
const profiles: WrapperManifestEngineProfile[] = [
  { id: 'local', executor: 'local' },
  { id: 'plain', executor: 'remote', scheduler: 'none', controller: 'detached_ssh' },
  { id: 'slurm-login', executor: 'remote', scheduler: 'slurm', controller: 'detached_ssh' },
  { id: 'slurm-head', executor: 'remote', scheduler: 'slurm', controller: 'sbatch' }
]
const base: WrapperTargetPolicyInput = {
  projectLocation: localLocation,
  resourceClass: 'light',
  profiles
}

function remote(
  scheduler: 'local' | 'slurm' = 'local',
  controller: 'login' | 'sbatch' = 'login'
): WrapperRemoteCandidate {
  return {
    hostProfileId: 'host-a',
    hostAlias: 'cluster-a',
    connectionId: 'connection-a',
    workspaceRoot: '/data/project',
    hpc: { scheduler, controller, runtime: 'singularity' }
  }
}

function doctor(
  candidate: WrapperRemoteCandidate,
  changes: Partial<WrapperTargetDoctorSnapshot> = {},
  checkChanges: Partial<Record<string, RemoteDoctorCheck['status']>> = {}
): WrapperTargetDoctorSnapshot {
  const ids = [
    'ssh',
    'sftp',
    'path',
    'path_read',
    'path_write',
    'shell',
    'nextflow',
    'java',
    'runtime',
    'slurm_submit',
    'slurm_status',
    'slurm_detail',
    'slurm_cancel'
  ]
  const checks = ids.map((id) => ({ id, status: checkChanges[id] ?? 'ok', message: id }))
  return {
    report: {
      hostProfileId: candidate.hostProfileId,
      checkedAt: '2026-09-24T00:00:00.000Z',
      ok: !checks.some((check) => check.status === 'error'),
      checks
    },
    remotePath: '/data/project',
    scheduler: candidate.hpc!.scheduler,
    controller: candidate.hpc!.controller ?? 'login',
    runtime: candidate.hpc!.runtime ?? 'singularity',
    ...changes
  }
}

test('SSH project uses only its bound host and canonical project path', () => {
  const candidate = remote()
  const selected = chooseWrapperTarget({
    ...base,
    projectLocation: sshLocation,
    remote: candidate,
    doctor: doctor(candidate)
  })
  assert.deepEqual(selected, {
    kind: 'selected',
    target: 'remote',
    executor: 'remote-background',
    profileId: 'plain',
    hostProfileId: 'host-a',
    hostAlias: 'cluster-a',
    remoteRoot: '/data/project',
    connectionId: 'connection-a',
    reason: '远程项目固定使用自身服务器和项目目录。'
  })
  const noConnection = chooseWrapperTarget({ ...base, projectLocation: sshLocation })
  assert.equal(noConnection.kind, 'blocked')
  if (noConnection.kind === 'blocked')
    assert.equal(noConnection.code, 'remote_connection_unavailable')
  assert.deepEqual(
    chooseWrapperTarget({
      ...base,
      projectLocation: sshLocation,
      explicitTarget: 'local',
      remote: candidate
    }),
    {
      kind: 'blocked',
      code: 'remote_project_local_target',
      reason: '远程项目的 Wrapper 不能在本机执行。'
    }
  )
  assert.equal(
    chooseWrapperTarget({
      ...base,
      projectLocation: sshLocation,
      remote: { ...candidate, hostProfileId: 'other' }
    }).kind,
    'blocked'
  )
  assert.equal(
    chooseWrapperTarget({
      ...base,
      projectLocation: sshLocation,
      remote: { ...candidate, workspaceRoot: '/elsewhere' }
    }).kind,
    'blocked'
  )
})

test('local light wrapper keeps its local profile; heavy work needs explicit acknowledgement', () => {
  const local = chooseWrapperTarget(base)
  assert.equal(local.kind, 'selected')
  if (local.kind === 'selected') {
    assert.equal(local.target, 'local')
    assert.equal(local.profileId, 'local')
  }
  const heavy = chooseWrapperTarget({ ...base, resourceClass: 'heavy' })
  assert.deepEqual(heavy.kind, 'blocked')
  if (heavy.kind === 'blocked') assert.equal(heavy.code, 'heavy_local_confirmation_required')
  const acknowledged = chooseWrapperTarget({
    ...base,
    resourceClass: 'hpc',
    explicitTarget: 'local',
    heavyLocalAcknowledged: true
  })
  assert.equal(acknowledged.kind, 'selected')
  if (acknowledged.kind === 'selected') assert.equal(acknowledged.target, 'local')
})

test('local project can explicitly choose its saved remote host; missing connection never falls back', () => {
  const candidate = remote()
  const selected = chooseWrapperTarget({
    ...base,
    explicitTarget: 'remote',
    remote: candidate,
    doctor: doctor(candidate)
  })
  assert.equal(selected.kind, 'selected')
  if (selected.kind === 'selected' && selected.target === 'remote') {
    assert.equal(selected.hostAlias, 'cluster-a')
    assert.equal(selected.remoteRoot, '/data/project')
    assert.equal(selected.profileId, 'plain')
  }
  const automatic = chooseWrapperTarget({ ...base, remote: candidate, doctor: doctor(candidate) })
  assert.equal(automatic.kind, 'selected')
  if (automatic.kind === 'selected') assert.equal(automatic.target, 'remote')
  const localOverride = chooseWrapperTarget({ ...base, explicitTarget: 'local', remote: candidate })
  assert.equal(localOverride.kind, 'selected')
  if (localOverride.kind === 'selected') assert.equal(localOverride.target, 'local')
  const unavailable = chooseWrapperTarget({ ...base, explicitTarget: 'remote' })
  assert.equal(unavailable.kind, 'blocked')
  if (unavailable.kind === 'blocked')
    assert.equal(unavailable.code, 'remote_connection_unavailable')
})

test('Slurm login and sbatch head choose the compatible profile and executor', () => {
  for (const [controller, profileId, executor] of [
    ['login', 'slurm-login', 'slurm'],
    ['sbatch', 'slurm-head', 'slurm-controller']
  ] as const) {
    const candidate = remote('slurm', controller)
    const result = chooseWrapperTarget({
      ...base,
      projectLocation: sshLocation,
      resourceClass: 'hpc',
      remote: candidate,
      doctor: doctor(candidate)
    })
    assert.equal(result.kind, 'selected')
    if (result.kind === 'selected') {
      assert.equal(result.executor, executor)
      assert.equal(result.profileId, profileId)
    }
  }
})

test('doctor must cover the same host, path and execution mode with required checks', () => {
  const candidate = remote('slurm', 'sbatch')
  const input = { ...base, projectLocation: sshLocation, remote: candidate }
  const unavailable = chooseWrapperTarget(input)
  assert.equal(unavailable.kind, 'blocked')
  if (unavailable.kind === 'blocked') assert.equal(unavailable.code, 'doctor_unavailable')
  const wrongPath = chooseWrapperTarget({
    ...input,
    doctor: doctor(candidate, { remotePath: '/other' })
  })
  assert.equal(wrongPath.kind, 'blocked')
  if (wrongPath.kind === 'blocked') assert.equal(wrongPath.code, 'doctor_mismatch')
  const wrongHost = chooseWrapperTarget({
    ...input,
    doctor: doctor(candidate, { report: { ...doctor(candidate).report, hostProfileId: 'other' } })
  })
  assert.equal(wrongHost.kind, 'blocked')
  if (wrongHost.kind === 'blocked') assert.equal(wrongHost.code, 'doctor_mismatch')
  const failedSlurm = chooseWrapperTarget({
    ...input,
    doctor: doctor(candidate, {}, { slurm_submit: 'error' })
  })
  assert.equal(failedSlurm.kind, 'blocked')
  if (failedSlurm.kind === 'blocked') {
    assert.equal(failedSlurm.code, 'doctor_not_ready')
    assert.match(failedSlurm.reason, /slurm_submit/)
  }
  const incomplete = doctor(candidate)
  incomplete.report.checks = incomplete.report.checks.filter((check) => check.id !== 'slurm_status')
  const result = chooseWrapperTarget({ ...input, doctor: incomplete })
  assert.equal(result.kind, 'blocked')
  if (result.kind === 'blocked') assert.equal(result.code, 'doctor_not_ready')
})

test('sbatch head can use compute-node-only Nextflow and Java with warnings', () => {
  const candidate = remote('slurm', 'sbatch')
  const result = chooseWrapperTarget({
    ...base,
    explicitTarget: 'remote',
    selectedProfileId: 'slurm-head',
    remote: candidate,
    doctor: doctor(candidate, {}, { nextflow: 'warning', java: 'warning', runtime: 'warning' })
  })
  assert.equal(result.kind, 'selected')
  if (result.kind === 'selected') assert.equal(result.executor, 'slurm-controller')
})

test('missing Slurm tools only permit the explicitly selected direct-host mode', () => {
  const direct = remote('local', 'login')
  const missingSlurm = {
    slurm_submit: 'warning' as const,
    slurm_status: 'warning' as const,
    slurm_detail: 'warning' as const,
    slurm_cancel: 'warning' as const
  }
  const selected = chooseWrapperTarget({
    ...base,
    explicitTarget: 'remote',
    selectedProfileId: 'plain',
    remote: direct,
    doctor: doctor(direct, {}, missingSlurm)
  })
  assert.equal(selected.kind, 'selected')
  if (selected.kind === 'selected') assert.equal(selected.executor, 'remote-background')
  const slurm = remote('slurm', 'login')
  const blocked = chooseWrapperTarget({
    ...base,
    explicitTarget: 'remote',
    selectedProfileId: 'slurm-login',
    remote: slurm,
    doctor: doctor(slurm, {}, { slurm_submit: 'error' })
  })
  assert.equal(blocked.kind, 'blocked')
  if (blocked.kind === 'blocked') assert.equal(blocked.code, 'doctor_not_ready')
})

test('saved setup defers tool results to launch while Doctor still requires SSH and workspace', () => {
  const candidate = remote('slurm', 'login')
  const checked = doctor(candidate, {}, { nextflow: 'warning', slurm_submit: 'warning' })
  checked.deferToolChecksToLaunch = true
  const selected = chooseWrapperTarget({
    ...base,
    explicitTarget: 'remote',
    selectedProfileId: 'slurm-login',
    remote: candidate,
    doctor: checked
  })
  assert.equal(selected.kind, 'selected')
  const missingWorkspace = doctor(candidate, {}, { path_write: 'error' })
  missingWorkspace.deferToolChecksToLaunch = true
  const blocked = chooseWrapperTarget({
    ...base,
    explicitTarget: 'remote',
    selectedProfileId: 'slurm-login',
    remote: candidate,
    doctor: missingWorkspace
  })
  assert.equal(blocked.kind, 'blocked')
})

test('a synchronous legacy plan can defer live doctor checks without changing its remote target', () => {
  const candidate = remote('slurm', 'sbatch')
  const pending = chooseWrapperTarget({
    ...base,
    projectLocation: sshLocation,
    remote: candidate,
    deferDoctorToExecution: true
  })
  assert.equal(pending.kind, 'selected')
  if (pending.kind === 'selected' && pending.target === 'remote') {
    assert.equal(pending.executor, 'slurm-controller')
    assert.equal(pending.hostAlias, 'cluster-a')
    assert.equal(pending.environmentCheckPending, true)
  }
  const failed = chooseWrapperTarget({
    ...base,
    projectLocation: sshLocation,
    remote: candidate,
    deferDoctorToExecution: true,
    doctor: doctor(candidate, {}, { ssh: 'error' })
  })
  assert.equal(failed.kind, 'blocked')
})

test('unsupported profile and invalid HPC settings are explicit errors', () => {
  const candidate = remote('slurm', 'sbatch')
  const unsupported = chooseWrapperTarget({
    ...base,
    projectLocation: sshLocation,
    remote: candidate,
    profiles: profiles.filter((profile) => profile.executor === 'local'),
    doctor: doctor(candidate)
  })
  assert.equal(unsupported.kind, 'blocked')
  if (unsupported.kind === 'blocked') assert.equal(unsupported.code, 'remote_profile_unavailable')
  const wrongProfile = chooseWrapperTarget({
    ...base,
    projectLocation: sshLocation,
    remote: candidate,
    selectedProfileId: 'local',
    doctor: doctor(candidate)
  })
  assert.equal(wrongProfile.kind, 'blocked')
  if (wrongProfile.kind === 'blocked') assert.equal(wrongProfile.code, 'remote_profile_unavailable')
  const invalid = chooseWrapperTarget({
    ...base,
    projectLocation: sshLocation,
    remote: remote('local', 'sbatch')
  })
  assert.equal(invalid.kind, 'blocked')
  if (invalid.kind === 'blocked') assert.equal(invalid.code, 'remote_configuration_invalid')
  const noSilentFallback = chooseWrapperTarget({
    ...base,
    resourceClass: 'heavy',
    remote: candidate,
    doctor: doctor(candidate, {}, { ssh: 'error' })
  })
  assert.equal(noSilentFallback.kind, 'blocked')
  if (noSilentFallback.kind === 'blocked') assert.equal(noSilentFallback.code, 'doctor_not_ready')
})
