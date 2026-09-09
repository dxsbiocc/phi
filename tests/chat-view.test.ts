import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import ChatView, { ThinkingBlock } from '../src/renderer/src/components/ChatView'
import ToolCallCard from '../src/renderer/src/components/ToolCallCard'
import ToolGroupCard from '../src/renderer/src/components/ToolGroupCard'
import {
  nextPromptHistoryCursor,
  promptHistoryFromMessages
} from '../src/renderer/src/lib/promptHistory'
import {
  appendInputReference,
  formatInputFileReferences,
  formatPromptAgentReference,
  formatPluginPromptReference,
  formatSkillPromptReference
} from '../src/renderer/src/lib/inputReferences'
import { toolActionKind } from '../src/renderer/src/lib/toolActions'
import type {
  ChatItem,
  PermissionMode,
  ToolApprovalRequest,
  ToolCallItem
} from '../src/renderer/src/types'

function renderChat(
  messages: ChatItem[],
  options: {
    permissionMode?: PermissionMode
    pendingApproval?: ToolApprovalRequest | null
    isGenerating?: boolean
    currentRunStartedAt?: string
    disableModelControls?: boolean
    compactComposerControls?: boolean
  } = {}
): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(ChatView, {
        messages,
        input: '',
        messagesContainerRef: () => undefined,
        canSend: true,
        isGenerating: options.isGenerating ?? false,
        currentRunStartedAt: options.currentRunStartedAt,
        models: [
          {
            providerId: 'kimi-code',
            modelId: 'kimi-for-coding',
            name: 'Kimi Coding',
            thinkingLevels: ['low', 'medium', 'high']
          }
        ],
        selectedModel: {
          providerId: 'kimi-code',
          modelId: 'kimi-for-coding',
          name: 'Kimi Coding',
          thinkingLevels: ['low', 'medium', 'high']
        },
        onSelectModel: () => undefined,
        thinkingLevel: 'high',
        onSelectThinkingLevel: () => undefined,
        onInputChange: () => undefined,
        onChatSubmit: async (event) => event.preventDefault(),
        onStopGeneration: async () => undefined,
        onGoSettings: () => undefined,
        permissionMode: options.permissionMode ?? 'auto',
        onSelectPermissionMode: () => undefined,
        disableModelControls: options.disableModelControls ?? false,
        pendingApproval: options.pendingApproval ?? null,
        onRespondApproval: () => undefined,
        onOpenApprovalSession: () => undefined,
        compactComposerControls: options.compactComposerControls ?? false
      })
    )
  )
}

function renderChatError(content: string): string {
  return renderChat([{ id: 'error-1', role: 'error', content }])
}

function renderToolGroup(items: ToolCallItem[]): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(ToolGroupCard, {
        items
      })
    )
  )
}

function renderToolCall(item: ToolCallItem): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(ToolCallCard, {
        item
      })
    )
  )
}

function renderThinkingBlock(content: string, durationMs?: number): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(ThinkingBlock, {
        content,
        durationMs
      })
    )
  )
}

function withMockedNow<T>(isoTimestamp: string, run: () => T): T {
  const originalNow = Date.now
  Date.now = () => Date.parse(isoTimestamp)
  try {
    return run()
  } finally {
    Date.now = originalNow
  }
}

test('chat view builds input history from submitted user messages', () => {
  const history = promptHistoryFromMessages([
    { id: 'user-1', role: 'user', content: '第一条' },
    { id: 'assistant-1', role: 'assistant', content: '收到' },
    { id: 'user-2', role: 'user', content: '  第二条  ' },
    { id: 'user-empty', role: 'user', content: '   ' }
  ])

  assert.deepEqual(history, ['第一条', '第二条'])
})

test('chat view navigates input history like a command line', () => {
  const historyLength = 3

  assert.equal(nextPromptHistoryCursor(historyLength, null, 'previous'), 2)
  assert.equal(nextPromptHistoryCursor(historyLength, 2, 'previous'), 1)
  assert.equal(nextPromptHistoryCursor(historyLength, 0, 'previous'), 0)
  assert.equal(nextPromptHistoryCursor(historyLength, 0, 'next'), 1)
  assert.equal(nextPromptHistoryCursor(historyLength, 2, 'next'), null)
  assert.equal(nextPromptHistoryCursor(historyLength, null, 'next'), null)
})

test('chat view formats add-menu references for prompt input', () => {
  assert.equal(
    formatInputFileReferences(['/workspace/a.csv', '/workspace/b.pdf']),
    '引用文件：\n- `/workspace/a.csv`\n- `/workspace/b.pdf`'
  )
  assert.equal(formatSkillPromptReference({ name: 'omics-visualization' }), '$omics-visualization')
  assert.equal(
    formatPromptAgentReference({ name: 'executor', trigger: '/prompts:executor' }),
    '/prompts:executor'
  )
  assert.equal(
    formatPluginPromptReference({ name: 'Bio Plugin', source: 'npm:@phi/bio' }),
    '引用插件：Bio Plugin（npm:@phi/bio）'
  )
  assert.equal(
    appendInputReference('先分析数据', '$omics-visualization'),
    '先分析数据\n$omics-visualization'
  )
})

test('chat view prompts recharge instead of provider configuration for billing failures', () => {
  const markup = renderChatError(
    '402 Insufficient Balance\nInsufficient Balance (type=unknown_error param=invalid_request_error)'
  )

  assert.match(markup, /账户余额不足/)
  assert.match(markup, /充值/)
  assert.doesNotMatch(markup, /原始错误/)
  assert.doesNotMatch(markup, /Insufficient Balance/)
  assert.doesNotMatch(markup, /去配置 Provider/)
})

test('chat view folds processing steps once the assistant answer is available', () => {
  const markup = renderChat([
    { id: 'user-1', role: 'user', content: '查一下' },
    {
      id: 'thinking-1',
      role: 'thinking',
      content: 'I should inspect the project first.',
      createdAt: '2026-09-07T00:00:00.000Z',
      completedAt: '2026-09-07T00:00:01.000Z',
      durationMs: 1000
    },
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'shell',
      argsPreview: 'rg provider',
      argsJson: '{"cmd":"rg provider"}',
      output: 'provider hit',
      status: 'done',
      createdAt: '2026-09-07T00:00:01.000Z',
      completedAt: '2026-09-07T00:00:02.000Z',
      durationMs: 1000
    },
    {
      id: 'tool-2',
      role: 'tool',
      toolName: 'shell',
      argsPreview: 'npm test',
      argsJson: '{"cmd":"npm test"}',
      output: 'all pass',
      status: 'done',
      createdAt: '2026-09-07T00:00:02.000Z',
      completedAt: '2026-09-07T00:00:04.000Z',
      durationMs: 2000
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '最终回复',
      createdAt: '2026-09-07T00:00:04.000Z'
    }
  ])

  assert.match(markup, /已完成，总共用时 4 秒/)
  assert.match(markup, /最终回复/)
  assert.doesNotMatch(markup, /处理过程：/)
  assert.doesNotMatch(markup, /I should inspect/)
  assert.doesNotMatch(markup, /rg provider/)
})

test('chat view wraps segmented processing in one fold per user turn', () => {
  const markup = renderChat([
    { id: 'user-1', role: 'user', content: '画图' },
    {
      id: 'thinking-1',
      role: 'thinking',
      content: '先检查 R 环境。',
      createdAt: '2026-09-07T00:00:00.000Z',
      completedAt: '2026-09-07T00:00:01.000Z',
      durationMs: 1000
    },
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'shell',
      argsPreview: 'R --version',
      argsJson: '{"cmd":"R --version"}',
      output: 'R 4.4.2',
      status: 'done',
      createdAt: '2026-09-07T00:00:01.000Z',
      completedAt: '2026-09-07T00:00:02.000Z',
      durationMs: 1000
    },
    {
      id: 'assistant-progress-1',
      role: 'assistant',
      content: 'R 可用，继续看数据。',
      createdAt: '2026-09-07T00:00:03.000Z'
    },
    {
      id: 'thinking-2',
      role: 'thinking',
      content: '选择 use_data.json。',
      createdAt: '2026-09-07T00:00:03.000Z',
      completedAt: '2026-09-07T00:00:04.000Z',
      durationMs: 1000
    },
    {
      id: 'tool-2',
      role: 'tool',
      toolName: 'read',
      argsPreview: 'use_data.json',
      argsJson: '{"path":"use_data.json"}',
      output: '{"rows":284}',
      status: 'done',
      createdAt: '2026-09-07T00:00:04.000Z',
      completedAt: '2026-09-07T00:00:05.000Z',
      durationMs: 1000
    },
    {
      id: 'assistant-final',
      role: 'assistant',
      content: '完成。产物是 stacked_bar.png。',
      createdAt: '2026-09-07T00:00:06.000Z'
    }
  ])

  assert.equal(markup.match(/已完成，总共用时/g)?.length ?? 0, 1)
  assert.match(markup, /已完成，总共用时 6 秒/)
  assert.doesNotMatch(markup, /处理过程：/)
  assert.match(markup, /完成。产物是 stacked_bar.png。/)
  assert.doesNotMatch(markup, /R 可用，继续看数据。/)
  assert.doesNotMatch(markup, /R --version/)
  assert.doesNotMatch(markup, /use_data.json/)
})

test('chat view keeps processing group neutral when a nested tool failed', () => {
  const markup = renderChat([
    { id: 'user-1', role: 'user', content: '查一下' },
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'shell',
      argsPreview: 'curl example',
      argsJson: '{"cmd":"curl example"}',
      output: 'failed',
      status: 'error',
      createdAt: '2026-09-07T00:00:00.000Z',
      completedAt: '2026-09-07T00:00:01.000Z',
      durationMs: 1000
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '换个方式继续。',
      createdAt: '2026-09-07T00:00:02.000Z'
    }
  ])

  assert.match(markup, /已完成，总共用时 2 秒/)
  assert.match(markup, /aria-label="展开处理过程"/)
  assert.doesNotMatch(markup, /处理过程：/)
  assert.doesNotMatch(markup, /aria-label="失败"/)
  assert.doesNotMatch(markup, /curl example/)
})

test('chat view keeps in-flight processing folded with a spinner before the assistant answer', () => {
  const markup = withMockedNow('2026-09-07T00:00:05.000Z', () =>
    renderChat([
      { id: 'user-1', role: 'user', content: '查一下' },
      {
        id: 'tool-1',
        role: 'tool',
        toolName: 'shell',
        argsPreview: 'rg provider',
        argsJson: '{"cmd":"rg provider"}',
        output: '',
        status: 'running',
        createdAt: '2026-09-07T00:00:00.000Z'
      }
    ])
  )

  assert.match(markup, /正在处理，已花费 5 秒/)
  assert.match(markup, /aria-label="展开处理过程"/)
  assert.doesNotMatch(markup, /处理过程：/)
  assert.doesNotMatch(markup, /rg provider/)
  assert.match(markup, /aria-label="执行中"/)
  assert.match(markup, /role="progressbar"/)
  assert.doesNotMatch(markup, />执行中</)
})

test('chat view uses the active run start time for running processing totals', () => {
  const markup = withMockedNow('2026-09-07T00:00:30.000Z', () =>
    renderChat(
      [
        { id: 'user-1', role: 'user', content: '查一下' },
        {
          id: 'tool-1',
          role: 'tool',
          toolName: 'shell',
          argsPreview: 'curl data',
          argsJson: '{"cmd":"curl data"}',
          output: '',
          status: 'running',
          createdAt: '2026-09-07T00:00:20.000Z'
        }
      ],
      {
        isGenerating: true,
        currentRunStartedAt: '2026-09-07T00:00:00.000Z'
      }
    )
  )

  assert.match(markup, /正在处理，已花费 30 秒/)
  assert.doesNotMatch(markup, /正在处理，已花费 10 秒/)
})

test('chat view shows grouped running tool calls with a spinner instead of status text', () => {
  const markup = withMockedNow('2026-09-07T00:00:05.000Z', () =>
    renderChat([
      { id: 'user-1', role: 'user', content: '查一下' },
      {
        id: 'tool-1',
        role: 'tool',
        toolName: 'shell',
        argsPreview: 'web_search LCI cohort',
        argsJson: '{"cmd":"web_search LCI cohort"}',
        output: '',
        status: 'running',
        createdAt: '2026-09-07T00:00:00.000Z'
      },
      {
        id: 'tool-2',
        role: 'tool',
        toolName: 'shell',
        argsPreview: 'web_search TIGER-LC',
        argsJson: '{"cmd":"web_search TIGER-LC"}',
        output: '',
        status: 'running',
        createdAt: '2026-09-07T00:00:02.000Z'
      }
    ])
  )

  assert.match(markup, /正在处理，已花费 5 秒/)
  assert.match(markup, /aria-label="执行中"/)
  assert.match(markup, /aria-label="展开处理过程"/)
  assert.match(markup, /role="progressbar"/)
  assert.doesNotMatch(markup, /处理过程：/)
  assert.doesNotMatch(markup, /web_search LCI cohort/)
  assert.doesNotMatch(markup, /正在运行 2 个命令/)
  assert.doesNotMatch(markup, /Ran 2 commands/)
})

test('chat view keeps the outer processing header to elapsed status only', () => {
  const markup = renderChat([
    { id: 'user-1', role: 'user', content: '查一下' },
    {
      id: 'thinking-1',
      role: 'thinking',
      content: '先思考。',
      createdAt: '2026-09-07T00:00:00.000Z',
      completedAt: '2026-09-07T00:00:01.000Z',
      durationMs: 1000
    },
    {
      id: 'tool-read',
      role: 'tool',
      toolName: 'read',
      argsPreview: 'src/App.tsx',
      argsJson: '{"path":"src/App.tsx"}',
      output: '',
      status: 'done',
      createdAt: '2026-09-07T00:00:01.000Z',
      completedAt: '2026-09-07T00:00:02.000Z',
      durationMs: 1000
    },
    {
      id: 'tool-edit',
      role: 'tool',
      toolName: 'edit',
      argsPreview: 'src/App.tsx',
      argsJson: '{"path":"src/App.tsx"}',
      output: '',
      status: 'done',
      createdAt: '2026-09-07T00:00:02.000Z',
      completedAt: '2026-09-07T00:00:03.000Z',
      durationMs: 1000
    },
    {
      id: 'tool-command',
      role: 'tool',
      toolName: 'bash',
      argsPreview: 'npm test',
      argsJson: '{"cmd":"npm test"}',
      output: 'pass',
      status: 'done',
      createdAt: '2026-09-07T00:00:03.000Z',
      completedAt: '2026-09-07T00:00:04.000Z',
      durationMs: 1000
    },
    {
      id: 'tool-search',
      role: 'tool',
      toolName: 'web_search',
      argsPreview: 'MUI icon docs',
      argsJson: '{"query":"MUI icon docs"}',
      output: 'result',
      status: 'done',
      createdAt: '2026-09-07T00:00:04.000Z',
      completedAt: '2026-09-07T00:00:05.000Z',
      durationMs: 1000
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '最终回复',
      createdAt: '2026-09-07T00:00:05.000Z'
    }
  ])

  assert.match(markup, /已完成，总共用时 5 秒/)
  assert.doesNotMatch(markup, /处理过程：/)
  assert.doesNotMatch(markup, /aria-label="思考"/)
  assert.doesNotMatch(markup, /aria-label="读取文件"/)
  assert.doesNotMatch(markup, /aria-label="编辑文件"/)
  assert.doesNotMatch(markup, /aria-label="运行命令"/)
  assert.doesNotMatch(markup, /aria-label="搜索"/)
})

test('chat view uses restored run lifecycle timestamps for completed processing totals', () => {
  const markup = renderChat([
    { id: 'user-1', role: 'user', content: '查一下' },
    {
      id: 'run-start',
      role: 'run',
      event: 'started',
      runId: 'run-1',
      createdAt: '2026-09-07T00:00:00.000Z'
    },
    {
      id: 'thinking-1',
      role: 'thinking',
      content: '这段思考耗时较长。',
      completedAt: '2026-09-07T00:00:20.000Z',
      durationMs: 15000
    },
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'shell',
      argsPreview: 'curl data',
      argsJson: '{"cmd":"curl data"}',
      output: 'ok',
      status: 'done',
      createdAt: '2026-09-07T00:00:20.000Z',
      completedAt: '2026-09-07T00:00:22.000Z',
      durationMs: 2000
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '最终回复',
      createdAt: '2026-09-07T00:00:25.000Z'
    },
    {
      id: 'run-end',
      role: 'run',
      event: 'completed',
      runId: 'run-1',
      createdAt: '2026-09-07T00:00:40.000Z'
    }
  ])

  assert.match(markup, /已完成，总共用时 40 秒/)
  assert.doesNotMatch(markup, /已完成，总共用时 22 秒/)
  assert.match(markup, /最终回复/)
})

test('chat view prefers persisted run duration over equal lifecycle timestamps', () => {
  const markup = renderChat([
    { id: 'user-1', role: 'user', content: '查一下' },
    {
      id: 'run-start',
      role: 'run',
      event: 'started',
      runId: 'run-1',
      createdAt: '2026-09-07T00:00:10.000Z'
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '完成',
      createdAt: '2026-09-07T00:00:10.000Z'
    },
    {
      id: 'run-end',
      role: 'run',
      event: 'completed',
      runId: 'run-1',
      createdAt: '2026-09-07T00:00:10.000Z',
      durationMs: 43000
    }
  ])

  assert.match(markup, /已完成，总共用时 43 秒/)
  assert.doesNotMatch(markup, /已完成，总共用时 0 秒/)
})

test('chat view hides a leading empty run lifecycle before the first user message', () => {
  const markup = renderChat([
    {
      id: 'run-start',
      role: 'run',
      event: 'started',
      runId: 'run-empty',
      createdAt: '2026-09-07T00:00:10.000Z'
    },
    {
      id: 'run-end',
      role: 'run',
      event: 'completed',
      runId: 'run-empty',
      createdAt: '2026-09-07T00:00:10.000Z'
    },
    { id: 'user-1', role: 'user', content: '查一下' },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '完成',
      createdAt: '2026-09-07T00:00:11.000Z'
    }
  ])

  assert.doesNotMatch(markup, /已完成，总共用时 0 秒/)
  assert.match(markup, /查一下/)
  assert.match(markup, /完成/)
})

test('thinking block shows elapsed time when folded and hides content until expanded', () => {
  const markup = renderThinkingBlock('这是一段很长的内部思考内容。', 4000)

  assert.match(markup, /思考了 4 s/)
  assert.match(markup, /aria-label="思考"/)
  assert.doesNotMatch(markup, /这是一段很长的内部思考内容/)
})

test('tool rows classify common actions with distinct icons', () => {
  assert.equal(toolActionKind('read', 'src/App.tsx', '{"path":"src/App.tsx"}'), 'read')
  assert.equal(toolActionKind('write', 'src/App.tsx', '{"path":"src/App.tsx"}'), 'edit')
  assert.equal(toolActionKind('bash', 'npm test', '{"cmd":"npm test"}'), 'command')
  assert.equal(toolActionKind('bash', 'rg provider', '{"cmd":"rg provider"}'), 'command')
  assert.equal(
    toolActionKind('eval', 'import pandas as pd', '{"code":"import pandas as pd"}'),
    'python'
  )
  assert.equal(
    toolActionKind('bash', 'curl https://example.com', '{"cmd":"curl https://example.com"}'),
    'command'
  )
  assert.equal(toolActionKind('web_search', 'MUI icon docs', '{"query":"MUI icon docs"}'), 'search')
  assert.equal(
    toolActionKind('read', 'https://example.com', '{"url":"https://example.com"}'),
    'web'
  )

  const markup = renderToolCall({
    id: 'tool-1',
    role: 'tool',
    toolName: 'bash',
    argsPreview: 'npm test',
    argsJson: '{"cmd":"npm test"}',
    output: 'pass',
    status: 'done'
  })

  assert.match(markup, /aria-label="运行命令"/)
  assert.match(markup, /执行命令/)
  assert.doesNotMatch(markup, /npm test/)

  const pythonMarkup = renderToolCall({
    id: 'tool-python',
    role: 'tool',
    toolName: 'eval',
    argsPreview: 'import pandas as pd import numpy as np from scipy import stats',
    argsJson: '{"code":"import pandas as pd\\nimport numpy as np\\nfrom scipy import stats"}',
    output: 'ok',
    status: 'done'
  })

  assert.match(pythonMarkup, /aria-label="执行 Python 代码"/)
  assert.match(pythonMarkup, /执行 Python 代码/)
  assert.doesNotMatch(pythonMarkup, /import pandas/)
  assert.doesNotMatch(pythonMarkup, />eval</)

  const pythonGroupMarkup = renderToolGroup([
    {
      id: 'tool-python',
      role: 'tool',
      toolName: 'eval',
      argsPreview: 'import pandas as pd import numpy as np from scipy import stats',
      argsJson: '{"code":"import pandas as pd\\nimport numpy as np\\nfrom scipy import stats"}',
      output: 'ok',
      status: 'done'
    }
  ])

  assert.match(pythonGroupMarkup, /已执行 Python 代码/)
  assert.doesNotMatch(pythonGroupMarkup, /import pandas/)

  const groupMarkup = renderToolGroup([
    {
      id: 'tool-read',
      role: 'tool',
      toolName: 'read',
      argsPreview: 'src/App.tsx',
      argsJson: '{"path":"src/App.tsx"}',
      output: '',
      status: 'done'
    },
    {
      id: 'tool-edit',
      role: 'tool',
      toolName: 'edit',
      argsPreview: 'src/App.tsx',
      argsJson: '{"path":"src/App.tsx"}',
      output: '',
      status: 'done'
    },
    {
      id: 'tool-command',
      role: 'tool',
      toolName: 'bash',
      argsPreview: 'npm test',
      argsJson: '{"cmd":"npm test"}',
      output: 'pass',
      status: 'done'
    },
    {
      id: 'tool-search',
      role: 'tool',
      toolName: 'web_search',
      argsPreview: 'MUI icon docs',
      argsJson: '{"query":"MUI icon docs"}',
      output: 'result',
      status: 'done'
    }
  ])

  assert.match(groupMarkup, /aria-label="读取文件"/)
  assert.match(groupMarkup, /aria-label="编辑文件"/)
  assert.match(groupMarkup, /aria-label="运行命令"/)
  assert.match(groupMarkup, /aria-label="搜索"/)
})

test('tool group keeps the aggregate row neutral when one child failed', () => {
  const markup = renderToolGroup([
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'shell',
      argsPreview: 'curl example',
      argsJson: '{"cmd":"curl example"}',
      output: 'failed',
      status: 'error'
    },
    {
      id: 'tool-2',
      role: 'tool',
      toolName: 'shell',
      argsPreview: 'curl fallback',
      argsJson: '{"cmd":"curl fallback"}',
      output: 'ok',
      status: 'done'
    }
  ])

  assert.match(markup, /已执行 2 条命令/)
  assert.doesNotMatch(markup, /命令运行失败/)
  assert.doesNotMatch(markup, /aria-label="失败"/)
  assert.doesNotMatch(markup, /curl example/)
  assert.doesNotMatch(markup, /curl fallback/)
})

test('chat view shows current permission mode in the composer', () => {
  const markup = renderChat([], { permissionMode: 'ask' })

  assert.match(markup, /权限 Ask/)
  assert.match(markup, /aria-label="选择权限模式"/)
})

test('chat view shows add-context control before permissions', () => {
  const markup = renderChat([])

  assert.match(markup, /aria-label="添加文件、智能体、Skill 或插件"[\s\S]*aria-label="选择权限模式/)
})

test('chat view shows full access permission mode in the composer', () => {
  const markup = renderChat([], { permissionMode: 'full' })

  assert.match(markup, /权限 Full/)
  assert.match(markup, /aria-label="选择权限模式"/)
})

test('chat view uses icon-only composer controls when file preview is open', () => {
  const markup = renderChat([], { compactComposerControls: true })

  assert.match(markup, /placeholder="输入消息"/)
  assert.match(markup, /aria-label="选择权限模式：权限 Auto"/)
  assert.match(markup, /aria-label="选择思考等级：High"/)
  assert.match(markup, /aria-label="选择模型：Kimi Coding"/)
  assert.match(markup, /data-phi-provider-icon="moonshot"/)
  assert.match(markup, /data-phi-provider-icon="moonshot"[\s\S]*>K</)
  assert.match(markup, /data-phi-composer-action="send" data-phi-composer-size="32"/)
  assert.doesNotMatch(markup, />权限 Auto</)
  assert.doesNotMatch(markup, />High</)
  assert.doesNotMatch(markup, />Kimi Coding</)
  assert.doesNotMatch(markup, /输入消息，Enter 发送/)
})

test('chat view keeps compact stop control the same size as other compact controls', () => {
  const compactMarkup = renderChat([], { compactComposerControls: true, isGenerating: true })
  const regularMarkup = renderChat([], { isGenerating: true })

  assert.match(compactMarkup, /data-phi-composer-action="stop" data-phi-composer-size="32"/)
  assert.match(regularMarkup, /data-phi-composer-action="stop" data-phi-composer-size="40"/)
})

test('chat view keeps next-run controls enabled and shows stop while the current session is busy', () => {
  const markup = renderChat([], { isGenerating: true })

  assert.doesNotMatch(markup, /aria-label="选择模型"[^>]*disabled/)
  assert.doesNotMatch(markup, /aria-label="选择权限模式"[^>]*disabled/)
  assert.match(markup, /Kimi Coding/)
  assert.match(markup, /aria-label="停止生成"/)
  assert.doesNotMatch(markup, /<textarea(?=[^>]*data-phi-focus="chat-input")(?=[^>]*disabled)/)
})

test('chat view renders tool approval inline instead of a modal dialog', () => {
  const markup = renderChat([], {
    pendingApproval: {
      requestId: 'approval-1',
      sessionPath: '/tmp/session.json',
      projectName: 'test',
      cwd: '/tmp/test',
      toolName: 'bash',
      summary: 'which R'
    }
  })

  assert.match(markup, /权限审批/)
  assert.match(markup, /执行终端命令/)
  assert.match(markup, /which R/)
  assert.doesNotMatch(markup, /role="dialog"/)
})
