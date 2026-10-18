import { beforeEach, afterEach } from 'node:test'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

// Keep these legacy behavioral assertions explicit about their presentation language.
beforeEach(() => setUiLanguage('zh-CN'))
afterEach(() => setUiLanguage('en'))

import assert from 'node:assert/strict'
import test from 'node:test'

import { createTheme, ThemeProvider } from '@mui/material/styles'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ManagedEnvironmentsSection } from '../src/renderer/src/features/environment/components/ManagedEnvironmentsSection'
import { EnvironmentBrandIcon } from '../src/renderer/src/features/environment/components/EnvironmentBrandIcon'
import type { EnvironmentSnapshot, ManagedEnvironmentEntry } from '../src/shared/environmentTypes'

const noop = (): void => undefined

test('environment brand icon has a round border and inherits the surface background', () => {
  const markup = renderToStaticMarkup(
    createElement(EnvironmentBrandIcon, {
      environment: {
        ref: 'phi:jupyter@1',
        envId: 'phi-jupyter-0123456789ab',
        state: 'absent',
        source: 'official',
        referrers: [],
        consumers: []
      },
      size: 52
    })
  )
  assert.match(markup, /border-radius:50%/)
  assert.doesNotMatch(markup, /background-color:/)
})

const snapshot: EnvironmentSnapshot = {
  scannedAt: '2026-10-11T00:00:00.000Z',
  firstScanCompleted: true,
  summaryDismissed: true,
  tools: [],
  hostDependencies: [
    { id: 'docker', label: 'Docker', status: 'ready', version: '28.0.1' },
    { id: 'singularity', label: 'Singularity / Apptainer', status: 'missing' }
  ],
  hostTools: [
    {
      id: 'jupyter',
      label: 'Jupyter',
      status: 'ready',
      management: 'host-unmanaged',
      selected: false,
      detectedPath: '/opt/homebrew/bin/jupyter',
      kernels: []
    },
    {
      id: 'nextflow',
      label: 'Nextflow',
      status: 'missing',
      management: 'host-unmanaged',
      selected: false
    }
  ]
}

function render(environments: ManagedEnvironmentEntry[]): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ManagedEnvironmentsSection, {
        environments,
        snapshot,
        loading: false,
        error: null,
        busyEnvId: null,
        onRetry: noop,
        onBuild: noop,
        onRebuild: noop,
        onRemove: noop,
        onClean: noop,
        onOpen: noop
      })
    )
  )
}

test('managed environments render as openable branded cards', () => {
  const markup = render([
    {
      ref: 'phi:jupyter@1',
      envId: 'phi-jupyter-0123456789ab',
      state: 'absent',
      source: 'official',
      label: 'phi-jupyter',
      description: '承载 Notebook 会话的 Jupyter Server。',
      estimate: { packages: 95, cachedPackages: 0, remainingBytes: 46 * 1024 ** 2 },
      referrers: [],
      consumers: [{ kind: 'notebook', name: 'jupyter-server', label: 'Notebook server' }]
    },
    {
      ref: 'phi:nextflow@1',
      envId: 'phi-nextflow-0123456789ab',
      state: 'absent',
      source: 'official',
      label: 'phi-nextflow',
      description: 'Wrapper 执行器使用的 Nextflow 与 Java 运行时。',
      estimate: { packages: 166, cachedPackages: 0, remainingBytes: 361 * 1024 ** 2 },
      referrers: [],
      consumers: [{ kind: 'wrapper', name: 'nextflow', label: 'Nextflow wrappers' }]
    },
    {
      ref: 'orphaned:plugin-visualization-viz-0123456789ab',
      envId: 'plugin-visualization-viz-0123456789ab',
      state: 'ready',
      source: 'orphaned',
      label: 'viz',
      sizeBytes: 1.7 * 1024 ** 3,
      referrers: ['plugin:visualization@1.0.2'],
      consumers: []
    }
  ])

  assert.match(markup, /data-phi-managed-environment-card="phi:jupyter@1"/)
  assert.match(markup, /aria-label="查看 phi-jupyter 详情"/)
  assert.match(markup, /aria-label="Jupyter 官方图标"/)
  assert.match(markup, /data-phi-environment-logo="jupyter"/)
  assert.match(markup, /data-phi-host-capability="jupyter"/)
  assert.match(markup, /Jupyter 可用/)
  assert.match(markup, /data-phi-host-capability="nextflow"/)
  assert.match(markup, /Nextflow 未发现/)
  assert.match(markup, /data-phi-host-capability="docker"/)
  assert.match(markup, /Docker 可用/)
  assert.doesNotMatch(markup, /data-phi-environment-capability="conda"/)
  assert.match(markup, /Singularity \/ Apptainer/)
  assert.equal(markup.match(/data-phi-environment-slot="capabilities"/g)?.length, 2)
  assert.equal(markup.match(/data-phi-environment-slot="estimate"/g)?.length, 2)
  assert.equal(markup.match(/data-phi-environment-slot="metrics"/g)?.length, 2)
  assert.equal(markup.match(/data-phi-environment-slot="actions"/g)?.length, 2)
  assert.doesNotMatch(markup, /data-phi-managed-environment-card="orphaned:/)
  assert.match(markup, /发现 1 个旧版遗留环境/)
  assert.match(markup, /清理遗留环境/)
  assert.match(markup, /查看估算并构建/)
  assert.doesNotMatch(markup, /无引用，可安全移除/)
  assert.match(markup, /MuiCardActionArea-focusHighlight\{display:none;/)
})
