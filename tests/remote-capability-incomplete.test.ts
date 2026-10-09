import assert from 'node:assert/strict'
import test from 'node:test'
import { createTheme, ThemeProvider } from '@mui/material'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { RemoteCapabilityProfileSummary } from '../src/renderer/src/features/wrapper/components/RemoteCapabilityProfileSummary'
import type { RemoteHostCapabilityProfile } from '../src/shared/remoteDoctorTypes'
import { doctorCheckFromCapability } from '../src/main/agent/workspace-host/capability-doctor'

const partialProfile: RemoteHostCapabilityProfile = {
  platform: { os: 'linux', arch: 'x86_64', libc: { name: 'glibc', version: '2.17' } },
  probedAt: '2026-10-09T02:00:00.000Z',
  fs: { state: 'available' },
  exec: { state: 'available' },
  background: { state: 'available' },
  pty: { state: 'unavailable', reason: 'helper 未安装' },
  watch: { state: 'unavailable', reason: 'helper 未安装' },
  forwardPort: { state: 'unavailable', reason: 'helper 未安装' },
  probe: { state: 'degraded', reason: 'slow capability detection timed out' },
  toolchain: {
    git: { state: 'available', version: '2.43.0' },
    nextflow: { state: 'degraded', reason: 'Nextflow detection timed out' },
    java: { state: 'degraded', reason: 'Java detection timed out' },
    conda: { state: 'degraded', reason: 'Conda detection timed out' },
    sbatch: { state: 'degraded', reason: 'Slurm detection timed out' },
    containerRuntime: { state: 'degraded', reason: 'container detection timed out' },
    module: { state: 'degraded', reason: 'module detection timed out' }
  }
}

test('doctor reports an incomplete capability as a warning instead of installed or missing', () => {
  const check = doctorCheckFromCapability(partialProfile.toolchain.nextflow, {
    id: 'nextflow',
    success: '找到 Nextflow 命令',
    missing: '未找到 Nextflow',
    missingStatus: 'error',
    suggestion: '安装 Nextflow。'
  })

  assert.equal(check.status, 'warning')
  assert.equal(check.message, 'Nextflow detection timed out')
  assert.doesNotMatch(`${check.message} ${check.suggestion ?? ''}`, /未找到|安装 Nextflow/)
})

test('settings summary labels partial timeouts without calling unknown tools missing', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(RemoteCapabilityProfileSummary, { profile: partialProfile })
    )
  )

  assert.match(markup, /部分检测超时/)
  assert.match(markup, /Nextflow detection timed out/)
  assert.doesNotMatch(markup, /Nextflow：未发现|Nextflow is not installed/)
})
