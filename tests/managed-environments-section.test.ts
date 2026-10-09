import assert from 'node:assert/strict'
import test from 'node:test'

import { createTheme, ThemeProvider } from '@mui/material/styles'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ManagedEnvironmentsSection } from '../src/renderer/src/features/environment/components/ManagedEnvironmentsSection'
import type { ManagedEnvironmentEntry } from '../src/shared/environmentTypes'

const noop = (): void => undefined

function render(environments: ManagedEnvironmentEntry[]): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ManagedEnvironmentsSection, {
        environments,
        loading: false,
        error: null,
        busyEnvId: null,
        onRetry: noop,
        onBuild: noop,
        onRebuild: noop,
        onRemove: noop,
        onClean: noop
      })
    )
  )
}

test('managed environments render as compact branded cards without a nested details surface', () => {
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
  assert.match(markup, /aria-label="Jupyter 官方图标"/)
  assert.match(markup, /data-phi-environment-logo="jupyter"/)
  assert.match(markup, /data-phi-environment-capability="notebook-server"/)
  assert.match(markup, /data-phi-environment-capability="java"/)
  assert.match(markup, /data-phi-environment-capability="docker"/)
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
  assert.doesNotMatch(markup, /查看详情/)
  assert.doesNotMatch(markup, /无引用，可安全移除/)
})
