import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { WrapperRemoteSettingsSection } from '../src/renderer/src/features/wrapper/components/WrapperRemoteSettings'
import type { Project } from '../src/renderer/src/types'

/**
 * Render-only smoke coverage — this project's test suite has no Electron
 * GUI automation, so a real click-through of the app can't happen in this
 * environment. `renderToStaticMarkup` at least proves the component
 * constructs without throwing across the prop shapes the settings dialog
 * actually passes (no projects, a project with no connections yet, a
 * project with connections including a default), and that both new IPC
 * methods' return shapes (`Project` with the new remote fields) are
 * consumed correctly.
 */
function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj1',
    name: 'Demo',
    workingDirectory: '/tmp/demo',
    permissionMode: 'ask',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function renderSection(projects: Project[]): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(WrapperRemoteSettingsSection, {
        projects,
        updatingProjectId: null,
        onUpdateRemoteConnection: async () => undefined,
        onUpdateRemoteDefaults: async () => undefined
      })
    )
  )
}

test('remote settings section shows an empty state with no projects', () => {
  const markup = renderSection([])
  assert.match(markup, /还没有项目/)
})

test('remote settings keeps an unconfigured local project out of the server list', () => {
  const markup = renderSection([baseProject()])
  assert.match(markup, /为本地项目配置远程 Wrapper/)
  assert.doesNotMatch(markup, /还没有配置远程连接/)
  assert.doesNotMatch(markup, /\/tmp\/demo/)
})

test('remote settings shows an SSH project even before it has Wrapper settings', () => {
  const markup = renderSection([
    baseProject({
      location: {
        kind: 'ssh',
        hostProfileId: 'ssh-config:lab',
        remoteRoot: '/data/lab',
        canonicalRoot: '/data/lab'
      }
    })
  ])
  assert.match(markup, /还没有配置远程连接/)
  assert.match(markup, /添加连接/)
})

test('remote settings section lists configured connections and marks the default one', () => {
  const markup = renderSection([
    baseProject({
      remoteConnections: [
        {
          id: 'conn1',
          label: 'Lab HPC',
          hostProfileId: 'host-1',
          inputPathMapping: { localRoot: '/tmp/demo/data', remoteRoot: '/cluster/data' }
        }
      ],
      defaultRemoteConnectionId: 'conn1',
      remoteWorkspaceRoot: '/cluster/facility/lab/WorkSpace'
    })
  ])
  assert.match(markup, /Lab HPC/)
  assert.match(markup, /需重新配置 SSH 服务器/)
  assert.match(markup, /默认/)
  assert.match(markup, /输入映射：\/tmp\/demo\/data → \/cluster\/data/)
  assert.doesNotMatch(markup, /私钥需要口令/)
})
