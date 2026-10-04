import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement, type ComponentProps, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import type { TerminalRendererBridge, TerminalSnapshot } from '../src/shared/terminalTypes'
import TerminalPanel from '../src/renderer/src/features/terminal/TerminalPanel'
import { TerminalPastePreview } from '../src/renderer/src/features/terminal/components/TerminalPastePreview'
import {
  TerminalStatusPane,
  type TerminalStatusKind
} from '../src/renderer/src/features/terminal/components/TerminalStatusPane'
import { TerminalTitleBar } from '../src/renderer/src/features/terminal/components/TerminalTitleBar'
import { disposeTerminalController } from '../src/renderer/src/features/terminal/lib/terminalController'
import { terminalWorkspaceRefFromActiveProject } from '../src/renderer/src/features/terminal/lib/terminalWorkspaceRef'
import type { Project } from '../src/renderer/src/lib/projectTypes'

function terminal(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    terminalId: 'terminal-1',
    workspaceKey: 'project:project-1',
    title: 'Terminal 1',
    host: 'local',
    initialCwd: '/work/project',
    shell: '/bin/zsh',
    state: 'open',
    createdAt: '2026-10-04T00:00:00.000Z',
    cols: 80,
    rows: 24,
    ...overrides
  }
}

function renderWithTheme(element: ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

const noop = (): void => undefined

function titleBarMarkup(overrides: Partial<ComponentProps<typeof TerminalTitleBar>> = {}): string {
  return renderWithTheme(
    createElement(TerminalTitleBar, {
      terminals: [terminal()],
      activeTerminalId: 'terminal-1',
      projectName: 'Phi',
      initialDirectory: '/work/project',
      maximized: false,
      canCreate: true,
      busy: false,
      onSelect: noop,
      onCreate: noop,
      onEnd: noop,
      onEndAll: noop,
      onToggleMaximize: noop,
      onCollapse: noop,
      ...overrides
    })
  )
}

test('terminal title bar matches the compact single-terminal control surface', () => {
  const markup = titleBarMarkup()

  assert.match(markup, /data-phi-terminal-title-bar="true"/)
  assert.match(markup, />Terminal</)
  assert.doesNotMatch(markup, /aria-label="选择终端"/)
  assert.match(markup, /aria-label="新建终端"/)
  assert.match(markup, /aria-label="更多终端操作"/)
  assert.match(markup, /aria-label="放大终端"/)
  assert.match(markup, /aria-label="收起终端面板"/)
  assert.match(markup, /初始目录：\/work\/project/)
  assert.match(markup, /height:44px/)
  assert.match(markup, /width:32px/)
  assert.match(markup, /-webkit-app-region:no-drag/)

  const maximized = titleBarMarkup({ maximized: true })
  assert.match(maximized, /aria-label="还原终端"/)
})

test('terminal title bar switches to a compact selector for multiple terminals', () => {
  const markup = titleBarMarkup({
    terminals: [
      terminal(),
      terminal({ terminalId: 'terminal-2', title: 'Terminal 2', initialCwd: '/work/other' })
    ],
    activeTerminalId: 'terminal-2'
  })

  assert.match(markup, /aria-label="选择终端"/)
  assert.match(markup, />Terminal 1</)
  assert.match(markup, />Terminal 2</)
  assert.match(markup, /value="terminal-2" selected=""/)
  assert.doesNotMatch(markup, />Terminal<\/span>/)
})

test('terminal status panes cover lifecycle, platform, remote, and limit states', () => {
  const cases: Array<{
    kind: TerminalStatusKind
    expected: RegExp
    props?: Partial<ComponentProps<typeof TerminalStatusPane>>
  }> = [
    { kind: 'starting', expected: /正在启动 Shell/ },
    { kind: 'exited', expected: /Shell 已退出（代码 7）/, props: { exitCode: 7 } },
    { kind: 'failed', expected: /Shell 无法启动/, props: { message: 'Shell 无法启动' } },
    { kind: 'remote', expected: /远程终端将在后续版本支持/ },
    { kind: 'unsupported', expected: /当前平台暂不支持终端/ },
    {
      kind: 'limit',
      expected: /已达到终端数量上限（当前 4 个）/,
      props: { terminalCount: 4 }
    }
  ]

  for (const item of cases) {
    const markup = renderWithTheme(
      createElement(TerminalStatusPane, {
        kind: item.kind,
        onCreate: noop,
        ...item.props
      })
    )
    assert.match(markup, new RegExp(`data-phi-terminal-status="${item.kind}"`))
    assert.match(markup, item.expected)
    if (item.kind === 'exited' || item.kind === 'failed') {
      assert.match(markup, />新建终端</)
    }
  }

  const limit = renderWithTheme(
    createElement(TerminalStatusPane, { kind: 'limit', terminalCount: 4 })
  )
  assert.match(limit, /请先结束一个终端后再新建/)
  assert.match(limit, /role="alert"/)
})

test('multi-line paste preview shows bounded context and explicit send/cancel actions', () => {
  const markup = renderWithTheme(
    createElement(TerminalPastePreview, {
      text: 'echo first\necho second\necho third',
      onSend: noop,
      onCancel: noop
    })
  )

  assert.match(markup, /data-phi-terminal-paste-preview="true"/)
  assert.match(markup, /aria-label="多行粘贴预览"/)
  assert.match(markup, /3 行/)
  assert.match(markup, /echo first/)
  assert.match(markup, /echo second/)
  assert.doesNotMatch(markup, /echo third/)
  assert.match(markup, />发送到终端</)
  assert.match(markup, />取消</)
})

test('terminal panel renders the thin reference-style shell without creating during SSR', () => {
  const bridge: TerminalRendererBridge = {
    list: async () => ({ ok: true, value: [] }),
    create: async () => {
      throw new Error('not called during server render')
    },
    attach: async () => {
      throw new Error('not called during server render')
    },
    input: async () => ({ ok: true, value: undefined }),
    resize: async () => ({ ok: true, value: undefined }),
    ack: async () => ({ ok: true, value: undefined }),
    close: async () => ({ ok: true, value: undefined }),
    onEvent: () => () => undefined
  }

  try {
    const markup = renderWithTheme(
      createElement(TerminalPanel, {
        bridge,
        projects: [],
        maximized: false,
        onToggleMaximize: noop,
        onCollapse: noop
      })
    )
    assert.match(markup, /data-phi-terminal-panel="true"/)
    assert.match(markup, /data-phi-terminal-viewport="true"/)
    assert.match(markup, /border-radius:16px/)
    assert.match(markup, /正在启动 Shell/)
    assert.doesNotMatch(markup, /当前没有终端/)
  } finally {
    disposeTerminalController()
  }
})

test('terminal workspace resolution rejects SSH fallback and UI never labels a current directory', () => {
  const localProject = {
    id: 'local-project',
    location: { kind: 'local', path: '/work/local', realPath: '/work/local' }
  } satisfies Pick<Project, 'id' | 'location'>
  const remoteProject = {
    id: 'remote-project',
    location: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: '/srv/work',
      canonicalRoot: '/srv/work'
    }
  } satisfies Pick<Project, 'id' | 'location'>

  assert.deepEqual(terminalWorkspaceRefFromActiveProject(null), { kind: 'ordinary' })
  assert.deepEqual(terminalWorkspaceRefFromActiveProject(localProject), {
    kind: 'project',
    projectId: 'local-project'
  })
  assert.equal(terminalWorkspaceRefFromActiveProject(remoteProject), 'remote')

  for (const file of [
    'TerminalPanel.tsx',
    'components/TerminalTitleBar.tsx',
    'components/TerminalStatusPane.tsx',
    'components/TerminalPastePreview.tsx',
    'hooks/useTerminalWorkspace.ts',
    'hooks/useTerminalWorkspaceRestoration.ts',
    'lib/terminalWorkspaceRef.ts'
  ]) {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/features/terminal', file),
      'utf8'
    )
    assert.doesNotMatch(source, /当前目录/)
  }
})
