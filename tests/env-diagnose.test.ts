import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildEnvDiagnoseTool,
  handleEnvironmentDiagnoseRequest
} from '../src/main/agent/content/env-diagnose-tool'
import { ensureEnvironmentReady } from '../src/main/agent/content/environment-gate'
import { describeEnvironment } from '../src/main/agent/content/environment-refs'
import {
  buildNextflowWindowsProfileGuidance,
  buildWslRemediationGuidance,
  diagnoseEnvironmentIssue,
  diagnoseLocalEnvironment,
  type EnvironmentDiagnosticReport
} from '../src/main/agent/environment/diagnose'
import { resolveNextflowLaunch } from '../src/main/agent/wrappers/composition/nextflow-launch'
import { CORE_TOOLS } from '../src/main/agent/core-tools'

test('CORE_TOOLS includes built-in env_diagnose', () => {
  assert.equal(CORE_TOOLS.has('env_diagnose'), true)
})

test('buildWslRemediationGuidance returns structured dual-path options for each WSL2 failure state', () => {
  const missing = buildWslRemediationGuidance({
    probe: { status: 'missing' },
    ref: 'phi:nextflow@1',
    remoteHosts: []
  })
  assert.equal(missing?.code, 'wsl_missing')
  assert.equal(missing?.options.length, 2)
  assert.equal(missing?.options[0]?.id, 'setup-wsl2')
  assert.deepEqual(missing?.options[0]?.commands, ['wsl --install'])
  assert.equal(missing?.options[0]?.recommended, true)
  assert.equal(missing?.options[1]?.id, 'configure-remote-host')
  assert.equal(missing?.options[1]?.settingsTarget, 'remote-hosts')

  const noDistro = buildWslRemediationGuidance({
    probe: { status: 'no-distro', executable: 'C:\\Windows\\System32\\wsl.exe' },
    ref: 'phi:nextflow@1',
    remoteHosts: [{ label: 'Lab HPC', hostAlias: 'lab-slurm' }]
  })
  assert.equal(noDistro?.code, 'wsl_no_distro')
  assert.deepEqual(noDistro?.options[0]?.commands, ['wsl --install -d Ubuntu'])
  assert.equal(noDistro?.options[1]?.id, 'use-remote-host')
  assert.equal(noDistro?.options[1]?.recommended, true)
  assert.match(noDistro?.options[1]?.steps[0] ?? '', /lab-slurm/u)

  const v1 = buildWslRemediationGuidance({
    probe: {
      status: 'not-version-2',
      executable: 'C:\\Windows\\System32\\wsl.exe',
      distro: 'Ubuntu-22.04',
      version: 1
    },
    ref: 'plugin:viz'
  })
  assert.equal(v1?.code, 'wsl_version_1')
  assert.deepEqual(v1?.options[0]?.commands, ['wsl --set-version Ubuntu-22.04 2'])

  const ready = buildWslRemediationGuidance({
    probe: { status: 'ready', executable: 'C:\\Windows\\System32\\wsl.exe', distro: 'Ubuntu' },
    ref: 'phi:nextflow@1'
  })
  assert.equal(ready, undefined)
})

test('resolveNextflowLaunch on Windows docker profile returns structured guidance alongside error text', async () => {
  const result = await resolveNextflowLaunch({
    platform: 'win32-x64',
    profile: 'docker',
    hostNextflowPath: () => undefined
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /WSL2.*docker.*conda/u)
  assert.equal(result.guidance?.code, 'nextflow_windows_profile')
  assert.equal(result.guidance?.ref, 'phi:nextflow@1')
  assert.equal(result.guidance?.options[0]?.id, 'use-conda-profile')
  assert.ok(
    result.guidance?.options[1]?.id === 'use-remote-host' ||
      result.guidance?.options[1]?.id === 'configure-remote-host'
  )
})

test('ensureEnvironmentReady short-circuits with WSL2 guidance before prompting build when WSL2 is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-gate-wsl-'))
  try {
    const descriptor = describeEnvironment('phi:nextflow@1', { platform: 'win32-x64' })
    assert.equal(descriptor.runtime, 'wsl2')
    let confirmCalled = false
    const outcome = await ensureEnvironmentReady({
      root,
      descriptor,
      ref: 'phi:nextflow@1',
      requester: { wrapper: 'nf-core/workflows/rnaseq' },
      runtimeSessionId: 'session-1',
      confirmBuild: async () => {
        confirmCalled = true
        return true
      },
      probeWsl: async () => ({ status: 'missing' }),
      signal: new AbortController().signal
    })
    assert.equal(confirmCalled, false)
    assert.equal(outcome.status, 'notReady')
    if (outcome.status !== 'notReady') return
    assert.equal(outcome.guidance?.code, 'wsl_missing')
    assert.match(outcome.message, /wsl --install/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('diagnoseLocalEnvironment reports Windows WSL2 blocker, managed envs, and saved remote hosts', async () => {
  const report = await diagnoseLocalEnvironment({
    hostPlatform: 'win32',
    arch: 'x64',
    platform: 'win32-x64',
    topic: 'nextflow',
    profile: 'singularity',
    probeWsl: () => ({ status: 'missing' }),
    detectHost: () => [{ id: 'wsl', label: 'WSL2', status: 'missing' }],
    listManaged: async () => [
      {
        ref: 'phi:nextflow@1',
        label: 'phi-nextflow',
        source: 'official',
        state: 'absent',
        runtime: 'wsl2',
        envId: 'phi-nextflow-1234567890ab',
        referrers: [],
        consumers: []
      }
    ],
    listRemoteHosts: () => [{ id: 'h1', label: 'BioHPC', hostAlias: 'biohpc-login' }]
  })
  assert.equal(report.platform.phiPlatform, 'win32-x64')
  assert.equal(report.wsl?.status, 'missing')
  assert.equal(report.remoteHosts.length, 1)
  assert.equal(report.remoteHosts[0]?.hostAlias, 'biohpc-login')
  assert.equal(report.guidance?.code, 'nextflow_windows_profile')
  assert.equal(report.guidance?.options[1]?.recommended, true)

  const wslOnly = diagnoseEnvironmentIssue({
    hostPlatform: 'win32',
    platform: 'win32-x64',
    ref: 'phi:nextflow@1',
    profile: 'conda',
    wslProbe: { status: 'no-distro', executable: 'C:\\Windows\\System32\\wsl.exe' },
    remoteHosts: []
  })
  assert.equal(wslOnly?.code, 'wsl_no_distro')

  const profileGuidance = buildNextflowWindowsProfileGuidance({ profile: 'docker', remoteHosts: [] })
  assert.equal(profileGuidance.options[0]?.recommended, true)
})

test('buildEnvDiagnoseTool validates parameters and formats host diagnostic report', async () => {
  const fakeReport: EnvironmentDiagnosticReport = {
    platform: { os: 'win32', arch: 'x64', phiPlatform: 'win32-x64' },
    wsl: { status: 'missing', message: 'WSL2 is not installed.' },
    hostDependencies: [{ id: 'wsl', label: 'WSL2', status: 'missing' }],
    managedEnvironments: [
      { ref: 'phi:nextflow@1', name: 'phi-nextflow', source: 'official', state: 'absent', runtime: 'wsl2' }
    ],
    remoteHosts: [{ id: 'h1', label: 'Cluster', hostAlias: 'slurm-01' }],
    guidance: buildWslRemediationGuidance({
      probe: { status: 'missing' },
      ref: 'phi:nextflow@1',
      remoteHosts: [{ label: 'Cluster', hostAlias: 'slurm-01' }]
    })
  }

  let capturedMethod = ''
  let capturedParams: unknown
  const tool = buildEnvDiagnoseTool(
    async (method, params) => {
      capturedMethod = method
      capturedParams = params
      return fakeReport
    },
    { runtimeSessionId: 'sess-diag' }
  )

  assert.equal(tool.name, 'env_diagnose')
  assert.equal(tool.approval, 'read')

  const invalid = await tool.execute(
    'call-1',
    { topic: 'invalid-topic' },
    undefined,
    { cwd: '/tmp' } as never,
    undefined
  )
  assert.equal(invalid.isError, true)

  const ok = await tool.execute(
    'call-2',
    { topic: 'nextflow', ref: 'phi:nextflow@1' },
    undefined,
    { cwd: '/tmp/project' } as never,
    undefined
  )
  assert.equal(ok.isError, undefined)
  assert.equal(capturedMethod, 'environments.diagnose')
  assert.deepEqual(capturedParams, {
    runtimeSessionId: 'sess-diag',
    cwd: '/tmp/project',
    topic: 'nextflow',
    ref: 'phi:nextflow@1'
  })
  const text = ok.content[0]?.type === 'text' ? ok.content[0].text : ''
  assert.match(text, /win32\/x64/u)
  assert.match(text, /wsl --install/u)
  assert.match(text, /slurm-01/u)
  assert.deepEqual(ok.details, fakeReport)

  const rpcResult = await handleEnvironmentDiagnoseRequest(
    { topic: 'wsl' },
    {
      hostPlatform: 'win32',
      arch: 'x64',
      platform: 'win32-x64',
      probeWsl: () => ({ status: 'missing' }),
      detectHost: () => [],
      listManaged: async () => [],
      listRemoteHosts: () => []
    }
  )
  assert.equal(rpcResult.guidance?.code, 'wsl_missing')
})
