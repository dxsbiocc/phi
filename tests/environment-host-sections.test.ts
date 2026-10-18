import { beforeEach, afterEach } from 'node:test'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

// Keep these legacy behavioral assertions explicit about their presentation language.
beforeEach(() => setUiLanguage('zh-CN'))
afterEach(() => setUiLanguage('en'))

import assert from 'node:assert/strict'
import test from 'node:test'

import { createTheme, ThemeProvider } from '@mui/material/styles'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { HostDependenciesList } from '../src/renderer/src/features/environment/components/HostDependenciesSection'
import { EnvironmentHostCapabilityChips } from '../src/renderer/src/features/environment/components/EnvironmentBrandIcon'
import { HostToolsList } from '../src/renderer/src/features/environment/components/HostToolsSection'

function render(element: ReactNode): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

test('host dependencies use a shared compact item layout', () => {
  const markup = render(
    createElement(HostDependenciesList, {
      dependencies: [
        {
          id: 'docker',
          label: 'Docker',
          status: 'ready',
          path: '/usr/local/bin/docker',
          version: '29.3.1'
        },
        { id: 'singularity', label: 'Singularity / Apptainer', status: 'missing' }
      ]
    })
  )

  assert.equal(markup.match(/data-phi-host-environment-item=/g)?.length, 2)
  assert.match(markup, /29\.3\.1 · \/usr\/local\/bin\/docker/)
  assert.match(markup, /未检测到可用路径/)
})

test('host tool details are always visible with enable switches on the right', () => {
  const markup = render(
    createElement(HostToolsList, {
      tools: [
        {
          id: 'nextflow',
          label: 'Nextflow',
          status: 'not-configured',
          management: 'host-unmanaged',
          selected: false,
          detectedPath: '/usr/local/bin/nextflow',
          version: '25.10.0'
        },
        {
          id: 'jupyter',
          label: 'Jupyter',
          status: 'ready',
          management: 'host-unmanaged',
          selected: false,
          kernels: [
            { id: 'python3', displayName: 'Python 3', language: 'python' },
            { id: 'ir', displayName: 'R', language: 'R' }
          ]
        }
      ],
      busy: false,
      onSavePath: async () => undefined
    })
  )

  assert.equal(markup.match(/data-phi-host-environment-item=/g)?.length, 2)
  assert.equal(markup.match(/data-phi-environment-choice="local"/g)?.length, 2)
  assert.match(markup, /aria-label="启用本机 Nextflow"/)
  assert.match(markup, /aria-label="启用本机 Jupyter"/)
  assert.match(markup, /2 个本机 kernel/)
  assert.match(markup, /本机 Nextflow 路径/)
  assert.match(markup, /已发现/)
  assert.doesNotMatch(markup, /未检测到.*检测到本机版本|检测到本机版本.*未检测到/)
  assert.match(markup, /Python 3 · python/)
  assert.doesNotMatch(markup, /配置|收起|MuiCollapse-root/)
})

test('host tool overview and detail share the same discovered status', () => {
  const nextflow = {
    id: 'nextflow' as const,
    label: 'Nextflow',
    status: 'not-configured' as const,
    management: 'host-unmanaged' as const,
    selected: false,
    detectedPath: '/opt/nextflow',
    version: '25.10.0'
  }
  const markup = render(
    createElement(EnvironmentHostCapabilityChips, {
      resources: { dependencies: [], tools: [nextflow] }
    })
  )

  assert.match(markup, /Nextflow 已发现/)
  assert.doesNotMatch(markup, /Nextflow 未检测到/)
})

test('legacy Nextflow banner text is not presented as a version', () => {
  const markup = render(
    createElement(HostToolsList, {
      tools: [
        {
          id: 'nextflow',
          label: 'Nextflow',
          status: 'not-configured',
          management: 'host-unmanaged',
          selected: false,
          detectedPath: '/opt/nextflow',
          version: 'N E X T F L O W'
        }
      ],
      busy: false,
      onSavePath: async () => undefined
    })
  )

  assert.match(markup, /已发现/)
  assert.match(markup, /\/opt\/nextflow/)
  assert.equal(markup.match(/\/opt\/nextflow/g)?.length, 1)
  assert.doesNotMatch(markup, /N E X T F L O W/)
})
