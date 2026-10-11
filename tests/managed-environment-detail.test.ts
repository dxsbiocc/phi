import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { ManagedEnvironmentDetail } from '../src/renderer/src/features/environment/components/ManagedEnvironmentDetail'
import type {
  EnvironmentHostDependency,
  EnvironmentHostTool,
  ManagedEnvironmentEntry
} from '../src/shared/environmentTypes'

const noop = (): void => undefined

function render(
  environment: ManagedEnvironmentEntry,
  hostResources: {
    dependencies: EnvironmentHostDependency[]
    tools: EnvironmentHostTool[]
  } = { dependencies: [], tools: [] }
): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ManagedEnvironmentDetail, {
        environment,
        busy: false,
        error: null,
        hostResources,
        hostBusy: false,
        onBack: noop,
        onBuild: noop,
        onRebuild: noop,
        onRemove: noop,
        onSaveHostPath: noop
      })
    )
  )
}

const jupyter: ManagedEnvironmentEntry = {
  ref: 'phi:jupyter@1',
  envId: 'phi-jupyter-0123456789ab',
  state: 'absent',
  source: 'official',
  label: 'phi-jupyter',
  description: 'Notebook 服务环境。',
  referrers: [],
  consumers: [{ kind: 'notebook', name: 'jupyter-server' }]
}

test('jupyter detail offers one local-or-managed choice without a duplicate Conda section', () => {
  const markup = render(jupyter, {
    dependencies: [],
    tools: [
      {
        id: 'jupyter',
        label: 'Jupyter',
        status: 'ready',
        management: 'host-unmanaged',
        selected: false,
        detectedPath: '/opt/homebrew/bin/jupyter',
        version: '2.17.3',
        kernels: []
      }
    ]
  })
  assert.match(markup, /返回环境列表/)
  assert.match(markup, /phi-jupyter/)
  assert.match(markup, /Notebook 服务环境/)
  assert.match(markup, /本机环境/)
  assert.match(markup, /Phi 托管环境/)
  assert.match(markup, /Jupyter/)
  assert.match(markup, /可用/)
  assert.match(
    markup,
    /data-phi-environment-choice="local" data-phi-environment-choice-selected="false"/
  )
  assert.match(
    markup,
    /data-phi-environment-choice="managed" data-phi-environment-choice-selected="true"/
  )
  assert.match(markup, /aria-label="启用 Phi 托管环境"/)
  assert.doesNotMatch(markup, /使用现有 Conda\/Mamba 环境/)
  assert.doesNotMatch(markup, /本地环境目录/)
  assert.doesNotMatch(markup, /可选的本机工具/)
})

test('local and managed environment switches are mutually exclusive', () => {
  const markup = render(jupyter, {
    dependencies: [],
    tools: [
      {
        id: 'jupyter',
        label: 'Jupyter',
        status: 'ready',
        management: 'host-unmanaged',
        selected: true,
        path: '/opt/homebrew/bin/jupyter',
        version: '2.17.3',
        kernels: []
      }
    ]
  })
  assert.match(
    markup,
    /data-phi-environment-choice="local" data-phi-environment-choice-selected="true"/
  )
  assert.match(
    markup,
    /data-phi-environment-choice="managed" data-phi-environment-choice-selected="false"/
  )
})

test('nextflow detail owns container runtime detection', () => {
  const markup = render(
    { ...jupyter, ref: 'phi:nextflow@1', label: 'phi-nextflow' },
    {
      tools: [
        {
          id: 'nextflow',
          label: 'Nextflow',
          status: 'missing',
          management: 'host-unmanaged',
          selected: false
        }
      ],
      dependencies: [
        { id: 'docker', label: 'Docker', status: 'ready', version: '28.0.1' },
        { id: 'singularity', label: 'Singularity / Apptainer', status: 'missing' }
      ]
    }
  )
  assert.match(markup, /Docker/)
  assert.match(markup, /Singularity \/ Apptainer/)
  assert.doesNotMatch(markup, /宿主依赖/)
  assert.doesNotMatch(markup, /使用现有 Conda\/Mamba 环境/)
})

test('python and R details only expose Phi-managed maintenance', () => {
  for (const [ref, label] of [
    ['phi:python@1', 'phi-python'],
    ['phi:r@1', 'phi-r']
  ] as const) {
    const markup = render({ ...jupyter, ref, label })
    assert.match(markup, /Phi 托管环境/)
    assert.match(
      markup,
      /data-phi-environment-choice="managed" data-phi-environment-choice-selected="true"/
    )
    assert.doesNotMatch(markup, /本机环境/)
    assert.doesNotMatch(markup, /使用现有 Conda\/Mamba 环境/)
    assert.doesNotMatch(markup, /本地环境目录/)
  }
})

test('Python and R details list locked dependency package versions', () => {
  const markup = render({
    ...jupyter,
    ref: 'phi:r@1',
    label: 'phi-r',
    packages: [
      { name: 'r-base', version: '4.4.3', manager: 'conda' },
      { name: 'GenomeInfoDbData', version: 'b5339e0', manager: 'github' }
    ]
  })
  assert.match(markup, /依赖包 · 2/)
  assert.match(markup, /data-phi-environment-package="r-base"/)
  assert.match(markup, /4\.4\.3/)
  assert.match(markup, /GenomeInfoDbData/)
  assert.match(markup, /b5339e0/)
})
