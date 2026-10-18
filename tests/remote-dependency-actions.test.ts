import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { RemoteDependencyActions } from '../src/renderer/src/features/wrapper/components/RemoteDependencyActions'
import type { RemoteDoctorReport } from '../src/shared/remoteDoctorTypes'

const report: RemoteDoctorReport = {
  hostProfileId: 'host-a',
  checkedAt: '2026-09-28T00:00:00.000Z',
  ok: false,
  checks: [
    { id: 'ssh', status: 'ok', message: 'Non-interactive SSH connection succeeded' },
    { id: 'java', status: 'ok', message: 'Java found' },
    { id: 'nextflow', status: 'error', message: 'Nextflow not found' },
    { id: 'slurm_submit', status: 'error', message: 'Slurm submission command not found' }
  ]
}

function render(override: RemoteDoctorReport = report): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(RemoteDependencyActions, {
        report: override,
        installing: false,
        onInstallNextflow: () => undefined
      })
    )
  )
}

test('missing Nextflow offers an explicit personal install or official manual instructions', () => {
  const markup = render()
  assert.match(markup, /Install Nextflow automatically/)
  assert.match(markup, /Manual installation instructions/)
  assert.match(markup, /Slurm.*does not install the scheduler/)
  assert.doesNotMatch(markup, /Connection failed/)
})

test('automatic Nextflow install stays unavailable until Java is ready', () => {
  const markup = render({
    ...report,
    checks: report.checks.map((check) =>
      check.id === 'java' ? { ...check, status: 'error', message: 'Java not found' } : check
    )
  })
  const button = markup.match(/<button[^>]*>Install Nextflow automatically<\/button>/)?.[0]
  assert.ok(button)
  assert.match(button, /disabled/)
  assert.match(markup, /Java 17\+/)
})

test('capability-backed missing Nextflow keeps install beside module and phi-base guidance', () => {
  const markup = render({
    ...report,
    checks: report.checks.map((check) =>
      check.id === 'nextflow'
        ? { ...check, suggestion: 'module load nextflow, or use the phi-base environment.' }
        : check
    )
  })

  assert.match(markup, /Install Nextflow automatically/)
  assert.match(markup, /module load nextflow, or use the phi-base environment/)
  assert.match(markup, /Copy suggestion/)
  assert.match(markup, /Manual installation instructions/)
})
