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
    { id: 'ssh', status: 'ok', message: 'SSH 非交互连接成功' },
    { id: 'java', status: 'ok', message: '找到 Java' },
    { id: 'nextflow', status: 'error', message: '未找到 Nextflow' },
    { id: 'slurm_submit', status: 'error', message: '未找到 Slurm 提交命令' }
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
  assert.match(markup, /自动安装 Nextflow/)
  assert.match(markup, /手动安装说明/)
  assert.match(markup, /Slurm.*不会安装调度系统/)
  assert.doesNotMatch(markup, /连接失败/)
})

test('automatic Nextflow install stays unavailable until Java is ready', () => {
  const markup = render({
    ...report,
    checks: report.checks.map((check) =>
      check.id === 'java' ? { ...check, status: 'error', message: '未找到 Java' } : check
    )
  })
  const button = markup.match(/<button[^>]*>自动安装 Nextflow<\/button>/)?.[0]
  assert.ok(button)
  assert.match(button, /disabled/)
  assert.match(markup, /Java 17\+/)
})

test('capability-backed missing Nextflow keeps install beside module and phi-base guidance', () => {
  const markup = render({
    ...report,
    checks: report.checks.map((check) =>
      check.id === 'nextflow'
        ? { ...check, suggestion: 'module load nextflow，或使用 phi-base 环境。' }
        : check
    )
  })

  assert.match(markup, /自动安装 Nextflow/)
  assert.match(markup, /module load nextflow，或使用 phi-base 环境/)
  assert.match(markup, /复制建议/)
  assert.match(markup, /手动安装说明/)
})
