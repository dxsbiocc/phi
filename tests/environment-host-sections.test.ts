import assert from 'node:assert/strict'
import test from 'node:test'

import { createTheme, ThemeProvider } from '@mui/material/styles'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { HostDependenciesSection } from '../src/renderer/src/features/environment/components/HostDependenciesSection'
import { HostToolsSection } from '../src/renderer/src/features/environment/components/HostToolsSection'

function render(element: ReactNode): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

test('host dependencies use a shared compact item layout', () => {
  const markup = render(
    createElement(HostDependenciesSection, {
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

test('optional host tool details stay collapsed until requested', () => {
  const markup = render(
    createElement(HostToolsSection, {
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
  assert.match(markup, /配置/)
  assert.match(markup, /2 个本机 kernel/)
  assert.doesNotMatch(markup, /本机 Nextflow 路径/)
  assert.doesNotMatch(markup, /Python 3 · python/)
})
