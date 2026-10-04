import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement, type ComponentProps, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import type { TerminalRendererBridge, TerminalSnapshot } from '../src/shared/terminalTypes'
import TerminalPanel from '../src/renderer/src/features/terminal/TerminalPanel'
import { TerminalAssistPanel } from '../src/renderer/src/features/terminal/components/TerminalAssistPanel'
import { TerminalPastePreview } from '../src/renderer/src/features/terminal/components/TerminalPastePreview'
import {
  TerminalStatusPane,
  type TerminalStatusKind
} from '../src/renderer/src/features/terminal/components/TerminalStatusPane'
import { TerminalTitleBar } from '../src/renderer/src/features/terminal/components/TerminalTitleBar'
import type { TerminalDraftState } from '../src/renderer/src/features/terminal/hooks/useTerminalDraft'
import { disposeTerminalController } from '../src/renderer/src/features/terminal/lib/terminalController'
import {
  EMPTY_TERMINAL_LINE_INPUT,
  isTerminalLineDirty,
  substituteTerminalDraftInputs,
  terminalDraftErrorMessage,
  terminalDraftRetentionRemovals,
  terminalDraftSelectionBoundary,
  updateTerminalLineInput
} from '../src/renderer/src/features/terminal/lib/terminalDraft'
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
      onOpenAssist: noop,
      onExplainSelection: noop,
      onEnd: noop,
      onEndAll: noop,
      onToggleMaximize: noop,
      onCollapse: noop,
      ...overrides
    })
  )
}

function draftState(overrides: Partial<TerminalDraftState> = {}): TerminalDraftState {
  return {
    terminalId: 'terminal-2',
    workspaceKey: 'project:project-1',
    kind: 'command',
    open: true,
    phase: 'result',
    request: 'create a marker file',
    draft: {
      draftId: 'draft-1',
      terminalId: 'terminal-2',
      workspaceKey: 'project:project-1',
      source: 'touch <marker>',
      explanation: 'Creates the requested marker file.',
      requiredInputs: [{ name: 'marker', description: 'Marker filename' }]
    },
    command: 'touch <marker>',
    inputValues: { marker: '' },
    readyForDirtyLine: false,
    selectionTruncated: false,
    submitting: false,
    submitted: false,
    ...overrides
  }
}

function assistMarkup(
  state: TerminalDraftState,
  overrides: Partial<ComponentProps<typeof TerminalAssistPanel>> = {}
): string {
  return renderWithTheme(
    createElement(TerminalAssistPanel, {
      state,
      targetLabel: 'Terminal 2',
      targetOpen: true,
      currentLineDirty: false,
      generationBusy: false,
      onRequestChange: noop,
      onSelectionChange: noop,
      onCommandChange: noop,
      onInputChange: noop,
      onReadyForDirtyLineChange: noop,
      onGenerate: noop,
      onCancelGeneration: noop,
      onCopy: noop,
      onSend: noop,
      onClose: noop,
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

  for (const label of ['新建终端', '更多终端操作', '放大终端', '收起终端面板']) {
    assert.equal(markup.match(new RegExp(`aria-label="${label}"`, 'gu'))?.length, 1)
  }

  const maximized = titleBarMarkup({ maximized: true })
  assert.match(maximized, /aria-label="还原终端"/)
  assert.equal(maximized.match(/aria-label="还原终端"/gu)?.length, 1)
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

  const trailingNewline = renderWithTheme(
    createElement(TerminalPastePreview, {
      text: 'echo first\necho second\n',
      onSend: noop,
      onCancel: noop
    })
  )
  assert.match(trailingNewline, /2 行/)
  assert.doesNotMatch(trailingNewline, /3 行/)
})

test('terminal assist panel keeps drafts explicit, terminal-bound, and input-gated', () => {
  const missingInput = assistMarkup(draftState())
  assert.match(missingInput, /data-phi-terminal-assist="true"/)
  assert.match(missingInput, /目标：Terminal 2/)
  assert.match(missingInput, /生成内容不会自动发送/)
  assert.match(missingInput, /发送到 Terminal 2/)
  assert.match(
    missingInput,
    /<button[^>]*disabled=""[^>]*>[\s\S]*?发送到 Terminal 2[\s\S]*?<\/button>/u
  )
  assert.match(missingInput, /Marker filename/)
  assert.match(missingInput, /touch &lt;marker&gt;/)

  const filledInput = assistMarkup(draftState({ inputValues: { marker: 'done.txt' } }))
  assert.match(filledInput, /data-phi-terminal-command-preview="true"/)
  assert.match(filledInput, /touch done.txt/)
  assert.doesNotMatch(
    filledInput,
    /<button[^>]*disabled=""[^>]*>[\s\S]*?发送到 Terminal 2[\s\S]*?<\/button>/u
  )

  const sent = assistMarkup(draftState({ inputValues: { marker: 'done.txt' }, submitted: true }))
  assert.match(sent, />已发送</)
  assert.match(sent, /<button[^>]*disabled=""[^>]*>[\s\S]*?已发送[\s\S]*?<\/button>/u)

  const closed = assistMarkup(draftState({ inputValues: { marker: 'done.txt' } }), {
    targetOpen: false
  })
  assert.match(closed, /目标终端已关闭，无法发送/)
  assert.match(closed, /<button[^>]*disabled=""[^>]*>[\s\S]*?发送到 Terminal 2[\s\S]*?<\/button>/u)
})

test('terminal assist panel requires dirty-line readiness and exposes editable selection removal', () => {
  const selection = 'selected output\nwith details'
  const markup = assistMarkup(
    draftState({
      kind: 'explain',
      selection,
      inputValues: { marker: 'done.txt' }
    }),
    { currentLineDirty: true }
  )

  assert.match(markup, /让 Agent 解释/)
  assert.match(markup, /附带的终端内容/)
  assert.match(markup, /selected output\nwith details/)
  assert.match(markup, />移除附带内容</)
  assert.match(markup, /我已准备好接收此命令（当前行已有输入）/)
  assert.match(markup, /<button[^>]*disabled=""[^>]*>[\s\S]*?发送到 Terminal 2[\s\S]*?<\/button>/u)

  const ready = assistMarkup(
    draftState({
      kind: 'explain',
      selection,
      inputValues: { marker: 'done.txt' },
      readyForDirtyLine: true
    }),
    { currentLineDirty: true }
  )
  assert.match(ready, /checked=""/)
  assert.doesNotMatch(
    ready,
    /<button[^>]*disabled=""[^>]*>[\s\S]*?发送到 Terminal 2[\s\S]*?<\/button>/u
  )
})

test('terminal draft helpers substitute inputs, expose UTF-8 truncation, and track line input', () => {
  assert.equal(
    substituteTerminalDraftInputs(
      'printf %s <value> && echo <value>',
      [{ name: 'value', description: '' }],
      { value: 'safe text' }
    ),
    'printf %s safe text && echo safe text'
  )
  assert.equal(terminalDraftErrorMessage('请先配置模型'), '请先在设置中配置模型')

  const boundary = terminalDraftSelectionBoundary(`${'a'.repeat(16 * 1024 - 1)}你`)
  assert.equal(boundary.truncated, true)
  assert.equal(boundary.includedCharacters, 16 * 1024 - 1)

  let line = updateTerminalLineInput(EMPTY_TERMINAL_LINE_INPUT, 'echo')
  assert.equal(isTerminalLineDirty(line), true)
  line = updateTerminalLineInput(line, '\u001b[A')
  assert.equal(line.printableCharacters, 4)
  line = updateTerminalLineInput(line, '\u007f')
  assert.equal(line.printableCharacters, 3)
  line = updateTerminalLineInput(line, '\u0015')
  assert.equal(isTerminalLineDirty(line), false)
  line = updateTerminalLineInput(line, 'pwd\r')
  assert.equal(isTerminalLineDirty(line), false)
})

test('terminal draft retention removes disappeared, expired, and over-limit entries', () => {
  const now = 2_000_000
  const entries = Array.from({ length: 34 }, (_, index) => ({
    terminalId: `terminal-${index}`,
    workspaceKey: index < 3 ? 'project:active' : 'project:other',
    lastTouchedAt: now - index
  }))
  entries.push({
    terminalId: 'terminal-expired',
    workspaceKey: 'project:other',
    lastTouchedAt: now - 30 * 60 * 1_000
  })

  const removals = terminalDraftRetentionRemovals(entries, {
    now,
    liveWorkspace: {
      workspaceKey: 'project:active',
      terminalIds: new Set(['terminal-0', 'terminal-2'])
    }
  })

  assert.equal(removals.includes('terminal-1'), true)
  assert.equal(removals.includes('terminal-expired'), true)
  assert.equal(removals.includes('terminal-0'), false)
  assert.equal(removals.includes('terminal-2'), false)
  assert.equal(removals.includes('terminal-3'), false)
  assert.equal(entries.length - removals.length, 32)
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
    assert.match(markup, /\.xterm-viewport\{[^}]*background-color:#FFFFFF/u)
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
