import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import ChatView, { ThinkingBlock } from '../src/renderer/src/features/chat/ChatView'
import { ProviderModelIcon } from '../src/renderer/src/components/chat/ProviderModelIcon'
import { composerSurfaceSx } from '../src/renderer/src/components/chat/composerControlStyles'
import ToolCallCard from '../src/renderer/src/components/ToolCallCard'
import ToolGroupCard from '../src/renderer/src/components/ToolGroupCard'
import {
  canNavigatePromptHistory,
  nextPromptHistoryCursor,
  promptHistoryFromMessages
} from '../src/renderer/src/lib/promptHistory'
import {
  appendInputReference,
  composeInputWithFileReferences,
  filterInputFileReferenceCandidates,
  findActiveInputFileReference,
  findActiveInputInvocationReference,
  formatInputFileReferences,
  formatInputFileReferenceTarget,
  formatPromptAgentReference,
  formatPluginPromptReference,
  formatSkillPromptReference,
  parseInputInvocationReferences,
  inputFileReferencePathsFromDroppedFiles,
  inputFileReferenceDirectoryPath,
  inputFileReferenceLeafQuery,
  parseInputFileReferences,
  removeInputInvocationReferenceRange,
  replaceInputReferenceRange
} from '../src/renderer/src/lib/inputReferences'
import { toolActionKind, toolApprovalLabel } from '../src/renderer/src/lib/toolActions'
import {
  suggestedNextActionPlaceholderFromMessages,
  suggestedNextActionToAccept
} from '../src/renderer/src/lib/suggestedNextAction'
import type {
  AgentUserInteractionRequest,
  ChatItem,
  PermissionMode,
  PromptAgentSummary,
  SkillSummary,
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
    input?: string
    images?: Array<{ mimeType: 'image/png'; data: string }>
    canQueue?: boolean
    pendingUserInteraction?: AgentUserInteractionRequest | null
    queuedPrompts?: Array<{ id: string; text: string }>
    skills?: SkillSummary[]
    promptAgents?: PromptAgentSummary[]
    onOpenLocalPath?: (path: string, kind: 'file' | 'directory') => void
    onOpenWebUrl?: (url: string) => void
    onForkUserMessage?: (messageId: string) => void
    planReviewEnabled?: boolean
    disablePlanReview?: boolean
    onTogglePlanReview?: () => void
    officeTarget?: {
      artifactId: string
      label: string
      selection?: { sheet?: string; range?: string; paths: string[] }
    }
    contextUsageTarget?: {
      sessionPath: string | null
      phiSessionId: string | null
      sessionGeneration: number
    }
    contextCompacting?: boolean
    onCompactContext?: () => void
  } = {}
): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(ChatView, {
        messages,
        input: options.input ?? '',
        images: options.images,
        messagesContainerRef: () => undefined,
        canSend: true,
        canQueue: options.canQueue ?? false,
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
        contextUsageTarget: options.contextUsageTarget,
        contextCompacting: options.contextCompacting,
        onCompactContext: options.onCompactContext,
        skills: options.skills ?? [],
        promptAgents: options.promptAgents ?? [],
        onSelectModel: () => undefined,
        thinkingLevel: 'high',
        onSelectThinkingLevel: () => undefined,
        onInputChange: () => undefined,
        onChatSubmit: async (event) => event.preventDefault(),
        onStopGeneration: async () => undefined,
        onGoSettings: () => undefined,
        onOpenBackgroundJobs: () => undefined,
        onOpenLocalPath: options.onOpenLocalPath,
        onOpenWebUrl: options.onOpenWebUrl,
        onForkUserMessage: options.onForkUserMessage,
        planReviewEnabled: options.planReviewEnabled,
        disablePlanReview: options.disablePlanReview,
        onTogglePlanReview: options.onTogglePlanReview,
        officeTarget: options.officeTarget,
        onRemoveOfficeTarget: () => undefined,
        onClearOfficeSelection: () => undefined,
        permissionMode: options.permissionMode ?? 'auto',
        onSelectPermissionMode: () => undefined,
        disableModelControls: options.disableModelControls ?? false,
        pendingApproval: options.pendingApproval ?? null,
        pendingUserInteraction: options.pendingUserInteraction ?? null,
        queuedPrompts: options.queuedPrompts ?? [],
        onRespondApproval: () => undefined,
        onRespondUserInteraction: () => undefined,
        onRemoveQueuedPrompt: () => undefined,
        onOpenApprovalSession: () => undefined,
        compactComposerControls: options.compactComposerControls ?? false
      })
    )
  )
}

test('chat composer shows the ready Office document association', () => {
  const markup = renderChat([], {
    officeTarget: { artifactId: 'artifact-1', label: '预算.xlsx' }
  })

  assert.match(markup, /关联文档：预算\.xlsx/)
  assert.match(markup, /aria-label="取消关联文档 预算\.xlsx"/)
})

test('chat composer shows a rectangular Office selection and a clear action', () => {
  const markup = renderChat([], {
    officeTarget: {
      artifactId: 'artifact-1',
      label: '预算.xlsx',
      selection: { sheet: 'Sheet1', range: 'A1:B3', paths: ['/Sheet1/A1'] }
    }
  })

  assert.match(markup, /关联文档：预算\.xlsx · 选区：Sheet1!A1:B3/)
  assert.match(markup, /data-phi-office-clear-selection="artifact-1"/)
  assert.match(markup, />清除选区</)
})

test('chat view threads the in-app web opener to assistant markdown links', () => {
  const markup = renderChat(
    [
      {
        id: 'assistant-web-link',
        role: 'assistant',
        content: '[Open the docs](https://example.com/docs)'
      }
    ],
    { onOpenWebUrl: () => undefined }
  )

  assert.match(markup, /href="https:\/\/example\.com\/docs"/)
  assert.match(markup, /data-phi-open-web-url="in-app"/)
})

function renderChatError(content: string): string {
  return renderChat([{ id: 'error-1', role: 'error', content }])
}

function renderToolGroup(
  items: ToolCallItem[],
  options: { onJumpToNotebookCell?: () => void } = {}
): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(ToolGroupCard, {
        items,
        onJumpToNotebookCell: options.onJumpToNotebookCell
      })
    )
  )
}

function renderToolCall(
  item: ToolCallItem,
  options: { onJumpToNotebookCell?: () => void } = {}
): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(ToolCallCard, {
        item,
        onJumpToNotebookCell: options.onJumpToNotebookCell
      })
    )
  )
}

test('collapsed hosted fetch card names its PubMed query', () => {
  const markup = renderToolCall({
    id: 'fetch-1',
    role: 'tool',
    toolName: 'web_fetch',
    argsPreview: 'https://pubmed.ncbi.nlm.nih.gov/?term=MID1IP1+OR+Mig12',
    argsJson: JSON.stringify({ url: 'https://pubmed.ncbi.nlm.nih.gov/?term=MID1IP1+OR+Mig12' }),
    output: 'results',
    status: 'done'
  })
  assert.match(markup, /PubMed 检索：MID1IP1 OR Mig12/)
})

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
  assert.equal(canNavigatePromptHistory('', null, 'previous'), true)
  assert.equal(canNavigatePromptHistory('   ', null, 'previous'), true)
  assert.equal(canNavigatePromptHistory('typed draft', null, 'previous'), false)
  assert.equal(canNavigatePromptHistory('typed draft', null, 'next'), false)
  assert.equal(canNavigatePromptHistory('历史内容', 1, 'previous'), true)
  assert.equal(canNavigatePromptHistory('历史内容', 1, 'next'), true)
})

test('chat view formats add-menu references for prompt input', () => {
  assert.equal(
    formatInputFileReferences(['/workspace/a.csv', '/workspace/b.pdf']),
    '引用文件：\n- `/workspace/a.csv`\n- `/workspace/b.pdf`'
  )
  assert.equal(
    formatInputFileReferences(
      ['/workspace/a.csv', '/workspace/.env', '/workspace/src/.cache/config.json'],
      '/workspace'
    ),
    '引用文件：`/workspace/a.csv`'
  )
  const droppedFile = { path: '/workspace/dropped.csv' } as File & { path: string }
  const bridgedFile = { path: '/workspace/legacy.csv' } as File & { path: string }
  assert.deepEqual(inputFileReferencePathsFromDroppedFiles([droppedFile]), [
    '/workspace/dropped.csv'
  ])
  assert.deepEqual(
    inputFileReferencePathsFromDroppedFiles([bridgedFile, bridgedFile], () => {
      throw new Error('webUtils unavailable')
    }),
    ['/workspace/legacy.csv']
  )
  assert.deepEqual(
    inputFileReferencePathsFromDroppedFiles([bridgedFile], () => '/workspace/ui.csv'),
    ['/workspace/ui.csv']
  )
  assert.equal(formatSkillPromptReference({ name: 'omics-visualization' }), '$omics-visualization')
  assert.equal(
    formatPromptAgentReference({ name: 'executor', trigger: '/prompts:executor' }),
    '/prompts:executor'
  )
  assert.equal(
    formatPromptAgentReference({
      name: 'Visualization',
      source: 'phi-agent',
      trigger: '调用智能体：Visualization'
    }),
    '调用智能体：Visualization'
  )
  assert.equal(
    formatPluginPromptReference({ name: 'Bio Plugin', source: 'npm:@phi/bio' }),
    '引用开发者扩展：Bio Plugin（npm:@phi/bio）'
  )
  assert.equal(
    appendInputReference('先分析数据', '$omics-visualization'),
    '先分析数据\n$omics-visualization'
  )
  assert.deepEqual(
    parseInputInvocationReferences(
      '$omics-visualization\n/prompts:analyst\n调用智能体：Visualization\n正文',
      [{ name: 'omics-visualization' }],
      [
        { name: 'analyst', source: 'codex-prompt', trigger: '/prompts:analyst' },
        {
          name: 'Visualization',
          source: 'phi-agent',
          trigger: '调用智能体：Visualization'
        }
      ]
    ),
    {
      references: [
        { kind: 'skill', name: 'omics-visualization', text: '$omics-visualization' },
        { kind: 'agent', name: 'analyst', text: '/prompts:analyst' },
        { kind: 'agent', name: 'Visualization', text: '调用智能体：Visualization' }
      ],
      body: '正文'
    }
  )
  assert.deepEqual(
    parseInputInvocationReferences(
      '/agent:Visualization\n正文',
      [],
      [
        {
          name: 'Visualization',
          source: 'phi-agent',
          trigger: '调用智能体：Visualization'
        }
      ]
    ),
    {
      references: [{ kind: 'agent', name: 'Visualization', text: '调用智能体：Visualization' }],
      body: '正文'
    }
  )
})

test('chat view resolves skill and agent shortcut queries in prompt input', () => {
  assert.deepEqual(findActiveInputInvocationReference('$ann', 4), {
    kind: 'skill',
    start: 0,
    end: 4,
    query: 'ann',
    operator: '$'
  })
  assert.deepEqual(findActiveInputInvocationReference('用 $ann 读取', 6), {
    kind: 'skill',
    start: 2,
    end: 6,
    query: 'ann',
    operator: '$'
  })
  assert.deepEqual(findActiveInputInvocationReference('/prompts:ana', 12), {
    kind: 'agent',
    start: 0,
    end: 12,
    query: 'ana',
    operator: '/prompts:'
  })
  assert.deepEqual(findActiveInputInvocationReference('/agent:Vis', 10), {
    kind: 'agent',
    start: 0,
    end: 10,
    query: 'Vis',
    operator: '/agent:'
  })
  assert.equal(findActiveInputInvocationReference('price$ann', 9), null)
  assert.equal(findActiveInputInvocationReference('$ann data', 9), null)

  const replacement = removeInputInvocationReferenceRange('使用 $ann 整理数据', {
    kind: 'skill',
    start: 3,
    end: 7,
    query: 'ann',
    operator: '$'
  })
  assert.equal(replacement.value, '使用 整理数据')
  assert.equal(replacement.cursor, 3)
})

test('chat view resolves @ file reference queries in prompt input', () => {
  assert.deepEqual(findActiveInputFileReference('请看 @src/App', 11), {
    start: 3,
    end: 11,
    query: 'src/App'
  })
  assert.deepEqual(findActiveInputFileReference('请看@src/App', 10), {
    start: 2,
    end: 10,
    query: 'src/App'
  })
  assert.deepEqual(findActiveInputFileReference('请看@', 3), {
    start: 2,
    end: 3,
    query: ''
  })
  assert.deepEqual(findActiveInputFileReference('请检查@并总结', 4), {
    start: 3,
    end: 4,
    query: ''
  })
  assert.deepEqual(findActiveInputFileReference('请检查@src/App并总结', 11), {
    start: 3,
    end: 11,
    query: 'src/App'
  })
  assert.equal(
    inputFileReferenceDirectoryPath('/workspace/project', 'src/renderer/App'),
    '/workspace/project/src/renderer'
  )
  assert.equal(inputFileReferenceDirectoryPath('/workspace/project', ''), '/workspace/project')
  assert.equal(inputFileReferenceLeafQuery('src/renderer/App'), 'App')
  assert.equal(inputFileReferenceDirectoryPath('/workspace/project', '../secret'), null)
  assert.equal(inputFileReferenceDirectoryPath('/workspace/project', '.git/config'), null)
  assert.equal(inputFileReferenceDirectoryPath('/workspace/project', 'src/.cache/file'), null)

  assert.equal(
    formatInputFileReferenceTarget({
      path: '/workspace/project/src/App.tsx',
      name: 'App.tsx',
      displayPath: 'src/App.tsx',
      kind: 'file'
    }),
    '引用文件：`./src/App.tsx`'
  )
  assert.equal(
    formatInputFileReferenceTarget({
      path: '/workspace/project/src',
      name: 'src',
      displayPath: 'src',
      kind: 'directory'
    }),
    '引用文件：`./src/`'
  )

  const replacement = replaceInputReferenceRange(
    '请检查 @src/App',
    { start: 4, end: 12, query: 'src/App' },
    '引用文件：`./src/App.tsx`'
  )
  assert.equal(replacement.value, '引用文件：`./src/App.tsx`\n请检查 ')
  assert.equal(replacement.cursor, '请检查 '.length)

  const inlineReplacement = replaceInputReferenceRange(
    '请检查@src/App并总结',
    { start: 3, end: 11, query: 'src/App' },
    '引用文件：`./src/App.tsx`'
  )
  assert.equal(inlineReplacement.value, '引用文件：`./src/App.tsx`\n请检查并总结')
  assert.equal(inlineReplacement.cursor, '请检查'.length)

  const bareTriggerReplacement = replaceInputReferenceRange(
    '请检查@并总结',
    { start: 3, end: 4, query: '' },
    '引用文件：`./src/App.tsx`'
  )
  assert.equal(bareTriggerReplacement.value, '引用文件：`./src/App.tsx`\n请检查并总结')
  assert.equal(bareTriggerReplacement.cursor, '请检查'.length)

  assert.deepEqual(
    filterInputFileReferenceCandidates(
      [
        {
          path: '/workspace/project/src',
          name: 'src',
          displayPath: 'src',
          kind: 'directory'
        },
        {
          path: '/workspace/project/package.json',
          name: 'package.json',
          displayPath: 'package.json',
          kind: 'file'
        },
        {
          path: '/workspace/project/.env',
          name: '.env',
          displayPath: '.env',
          kind: 'file'
        },
        {
          path: '/workspace/project/.git',
          name: '.git',
          displayPath: '.git',
          kind: 'directory'
        },
        {
          path: '/workspace/project/src/.cache/config.json',
          name: 'config.json',
          displayPath: 'src/.cache/config.json',
          kind: 'file'
        }
      ],
      'pack'
    ).map((entry) => entry.displayPath),
    ['package.json']
  )
  assert.deepEqual(
    filterInputFileReferenceCandidates(
      [
        {
          path: '/workspace/project/src',
          name: 'src',
          displayPath: 'src',
          kind: 'directory'
        },
        {
          path: '/workspace/project/.env',
          name: '.env',
          displayPath: '.env',
          kind: 'file'
        },
        {
          path: '/workspace/project/.git',
          name: '.git',
          displayPath: '.git',
          kind: 'directory'
        }
      ],
      ''
    ).map((entry) => entry.displayPath),
    ['src']
  )
})

test('chat composer input references preserve editable body spaces', () => {
  assert.deepEqual(parseInputFileReferences('hello '), {
    references: [],
    body: 'hello '
  })
  assert.deepEqual(parseInputFileReferences('hello\n'), {
    references: [],
    body: 'hello\n'
  })
  assert.equal(composeInputWithFileReferences([], 'hello '), 'hello ')
  assert.equal(composeInputWithFileReferences([], 'hello\n'), 'hello\n')
  assert.equal(composeInputWithFileReferences([], '  '), '  ')
  assert.deepEqual(parseInputFileReferences('引用文件：`/workspace/a.csv`\nhello '), {
    references: ['/workspace/a.csv'],
    body: 'hello '
  })
  assert.deepEqual(parseInputFileReferences('引用文件：`/workspace/a.csv`\nhello\n'), {
    references: ['/workspace/a.csv'],
    body: 'hello\n'
  })
  assert.equal(
    composeInputWithFileReferences(['/workspace/a.csv'], 'hello '),
    '引用文件：`/workspace/a.csv`\nhello '
  )
})

test('chat view parses and renders file references as cards', () => {
  assert.deepEqual(
    parseInputFileReferences(
      '引用文件：\n- `/workspace/hibit.diff.exp.genes.csv`\n- `/workspace/sirna.diff.exp.genes.csv`\n帮我绘制交叠情况'
    ),
    {
      references: ['/workspace/hibit.diff.exp.genes.csv', '/workspace/sirna.diff.exp.genes.csv'],
      body: '帮我绘制交叠情况'
    }
  )

  const composerMarkup = renderChat([], {
    input: '引用文件：`/workspace/hibit.diff.exp.genes.csv`\n随心输入'
  })
  assert.match(composerMarkup, /data-phi-file-drop-target="chat-composer"/)
  assert.match(composerMarkup, /hibit\.diff\.exp\.genes\.csv/)
  assert.match(composerMarkup, /aria-label="移除引用文件 hibit\.diff\.exp\.genes\.csv"/)
  assert.match(composerMarkup, /随心输入/)
  assert.doesNotMatch(composerMarkup, /引用文件：/)

  const officeComposerMarkup = renderChat([], {
    input: '引用文件：`/workspace/商铺.pptx`\n检查演示文稿'
  })
  assert.equal(officeComposerMarkup.match(/data-phi-material-icon="powerpoint"/g)?.length ?? 0, 1)
  assert.doesNotMatch(officeComposerMarkup, /data-phi-missing-material-icon="powerpoint"/)

  const messageMarkup = renderChat([
    {
      id: 'user-1',
      role: 'user',
      content:
        '引用文件：\n- `/workspace/hibit.diff.exp.genes.csv`\n- `/workspace/sirna.diff.exp.genes.csv`\n帮我绘制一张图对比HiBiT和siRNA两组差异基因之间的交叠情况'
    }
  ])
  assert.match(messageMarkup, /hibit\.diff\.exp\.genes\.csv/)
  assert.match(messageMarkup, /sirna\.diff\.exp\.genes\.csv/)
  assert.match(messageMarkup, /帮我绘制一张图/)
  assert.match(messageMarkup, /border-radius:18px/)
  assert.doesNotMatch(messageMarkup, />CSV</)
  assert.doesNotMatch(messageMarkup, /引用文件：/)
})

test('chat composer renders agent and skill references as chips', () => {
  const markup = renderChat([], {
    input: '$anndata\n/prompts:analyst\n调用智能体：Visualization\n整理一下数据',
    skills: [
      {
        id: '/skills/anndata/SKILL.md',
        name: 'anndata',
        description: 'AnnData skill',
        filePath: '/skills/anndata/SKILL.md',
        source: 'bundled',
        scope: 'user',
        sourceCategory: 'system',
        sourceCategoryLabel: 'System',
        disabled: false
      }
    ],
    promptAgents: [
      {
        id: '/prompts/analyst.md',
        name: 'analyst',
        description: 'Analyst prompt',
        source: 'codex-prompt',
        trigger: '/prompts:analyst'
      },
      {
        id: '/agents/Visualization.md',
        name: 'Visualization',
        description: 'Visualization agent',
        source: 'phi-agent',
        trigger: '调用智能体：Visualization'
      }
    ]
  })

  assert.match(markup, /data-phi-slot="composer-reference-chips"/)
  assert.equal(markup.match(/data-phi-reference-kind="skill"/g)?.length ?? 0, 1)
  assert.equal(markup.match(/data-phi-reference-kind="agent"/g)?.length ?? 0, 2)
  assert.match(markup, />anndata</)
  assert.match(markup, />analyst</)
  assert.match(markup, />Visualization</)
  assert.match(markup, /整理一下数据/)
  assert.doesNotMatch(markup, />\$anndata</)
  assert.doesNotMatch(markup, /\/prompts:analyst/)
  assert.doesNotMatch(markup, /调用智能体：Visualization/)
})

test('chat composer offers skill and agent shortcut reference candidates', () => {
  const skillMarkup = renderChat([], {
    input: '$ann',
    skills: [
      {
        id: '/skills/anndata/SKILL.md',
        name: 'anndata',
        description: 'AnnData skill',
        filePath: '/skills/anndata/SKILL.md',
        source: 'bundled',
        scope: 'user',
        sourceCategory: 'system',
        sourceCategoryLabel: 'System',
        disabled: false
      },
      {
        id: '/skills/scanpy/SKILL.md',
        name: 'scanpy',
        description: 'Scanpy skill',
        filePath: '/skills/scanpy/SKILL.md',
        source: 'bundled',
        scope: 'user',
        sourceCategory: 'system',
        sourceCategoryLabel: 'System',
        disabled: false
      }
    ]
  })
  assert.match(skillMarkup, /aria-label="引用 Skill 或智能体"/)
  assert.match(skillMarkup, />\$ann</)
  assert.match(skillMarkup, />anndata</)
  assert.doesNotMatch(skillMarkup, />scanpy</)

  const agentMarkup = renderChat([], {
    input: '/agent:Vis',
    promptAgents: [
      {
        id: '/agents/Visualization.md',
        name: 'Visualization',
        description: 'Visualization agent',
        source: 'phi-agent',
        trigger: '调用智能体：Visualization'
      },
      {
        id: '/prompts/analyst.md',
        name: 'analyst',
        description: 'Analyst prompt',
        source: 'codex-prompt',
        trigger: '/prompts:analyst'
      }
    ]
  })
  assert.match(agentMarkup, /aria-label="引用 Skill 或智能体"/)
  assert.match(agentMarkup, />\/agent:Vis</)
  assert.match(agentMarkup, />Visualization</)
  assert.doesNotMatch(agentMarkup, />analyst</)
})

test('chat view keeps user messages right aligned inside virtual rows', () => {
  const markup = renderChat([{ id: 'user-1', role: 'user', content: '当前运行的notebook有哪些' }])

  assert.match(
    markup,
    /\{[^}]*display:flex;[^}]*flex-direction:column;padding-top:0px;min-width:0;\}/
  )
  assert.match(markup, /align-self:flex-end;max-width:75%/)
  assert.match(markup, /当前运行的notebook有哪些/)
})

test('chat view shows copy and edit hover actions for normal user messages', () => {
  const markup = renderChat([{ id: 'user-1', role: 'user', content: '当前运行的notebook有哪些' }])

  assert.match(markup, /aria-label="复制消息"/)
  assert.match(markup, /aria-label="编辑消息"/)
  assert.doesNotMatch(markup, /aria-label="重试消息"/)
})

test('chat view offers a fork action for a completed image-only user message', () => {
  const markup = renderChat(
    [
      {
        id: 'image-event',
        role: 'user',
        content: '',
        images: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }]
      }
    ],
    { onForkUserMessage: () => undefined }
  )
  assert.match(markup, /aria-label="从此消息分叉会话"/)
})

test('chat view previews a pasted image and permits an image-only message', () => {
  const image = { mimeType: 'image/png' as const, data: 'iVBORw0KGgo=' }
  const markup = renderChat([{ id: 'user-image', role: 'user', content: '', images: [image] }], {
    images: [image]
  })
  assert.match(markup, /aria-label="待发送图片"/)
  assert.match(markup, /aria-label="预览待发送图片 1"/)
  assert.match(markup, /aria-label="移除图片 1"/)
  assert.match(markup, /aria-label="预览消息图片 1"/)
  assert.match(markup, /alt="消息图片 1"/)
  assert.doesNotMatch(markup, /aria-label="编辑消息"/)
})

test('chat view shows each changed file with counts and an open action', () => {
  const markup = renderChat(
    [
      { id: 'user-1', role: 'user', content: 'edit the result' },
      {
        id: 'changes-1',
        role: 'workspace_changes',
        files: [
          {
            path: '/project/result.txt',
            displayPath: 'result.txt',
            status: 'modified',
            added: 2,
            deleted: 1,
            diff: {
              sessionId: '11111111-1111-1111-1111-111111111111',
              id: 'a'.repeat(64),
              bytes: 32
            }
          }
        ],
        totalChanged: 1,
        truncated: false
      }
    ],
    { onOpenLocalPath: () => undefined }
  )
  assert.match(markup, /运行期间文件变化/)
  assert.match(markup, /aria-label="预览改动文件 result\.txt"/)
  assert.match(markup, /aria-label="查看 result\.txt 的本轮差异"/)
  assert.match(markup, />\+2<\/span>/)
  assert.match(markup, />−1<\/span>/)
})

test('workspace changes show four files before expanding the rest', () => {
  const markup = renderChat([
    {
      id: 'changes-compact',
      role: 'workspace_changes',
      files: Array.from({ length: 6 }, (_, index) => ({
        path: `/project/result-${index}.txt`,
        displayPath: `result-${index}.txt`,
        status: 'added' as const,
        added: index + 1,
        deleted: 0
      })),
      totalChanged: 6,
      truncated: false
    }
  ])

  assert.equal((markup.match(/data-phi-workspace-change-row=/g) ?? []).length, 4)
  assert.match(markup, /显示其余 2 项/)
  assert.doesNotMatch(markup, /result-5\.txt/)
})

test('a truncated change list stays visibly marked while collapsed', () => {
  const markup = renderChat([
    {
      id: 'changes-truncated',
      role: 'workspace_changes',
      files: [
        {
          path: '/project/report.txt',
          displayPath: 'report.txt',
          status: 'added',
          added: 1,
          deleted: 0
        }
      ],
      totalChanged: 50,
      truncated: true
    }
  ])

  assert.match(markup, /列表截断/)
})

test('chat view shows delivered files with a preview action and current-file notice', () => {
  const markup = renderChat(
    [
      {
        id: 'delivery-1',
        role: 'presented_files',
        files: [
          {
            path: '/project/report.pdf',
            displayPath: 'report.pdf',
            bytes: 123,
            description: '报告'
          }
        ]
      }
    ],
    { onOpenLocalPath: () => undefined }
  )
  assert.match(markup, /aria-label="交付文件"/)
  assert.match(markup, /aria-label="预览交付文件 report.pdf"/)
  assert.match(markup, /data-phi-presented-file-row="true"/)
  assert.match(markup, /<button[^>]*aria-label="预览交付文件 report\.pdf"/)
  assert.match(markup, /报告/)
  assert.match(markup, /内容可能已更改/)
})

test('chat view groups separate PNG and PDF deliveries under one title and notice', () => {
  const markup = renderChat(
    [
      {
        id: 'delivery-png',
        role: 'presented_files',
        runId: 'run-1',
        files: [{ path: '/project/heatmap.png', displayPath: 'heatmap.png', bytes: 302_000 }]
      },
      {
        id: 'delivery-pdf',
        role: 'presented_files',
        runId: 'run-1',
        files: [{ path: '/project/heatmap.pdf', displayPath: 'heatmap.pdf', bytes: 8_800 }]
      }
    ],
    { onOpenLocalPath: () => undefined }
  )

  assert.equal((markup.match(/aria-label="交付文件"/g) ?? []).length, 1)
  assert.equal((markup.match(/data-phi-presented-file-row="true"/g) ?? []).length, 2)
  assert.equal((markup.match(/>打开的是工作区中的当前文件，内容可能已更改。</g) ?? []).length, 1)
  assert.match(markup, />2 个</)
  assert.match(markup, /aria-label="预览交付文件 heatmap\.png"/)
  assert.match(markup, /aria-label="预览交付文件 heatmap\.pdf"/)
})

test('chat view labels Office deliverables by kind and shows remaining warnings', () => {
  const markup = renderChat(
    [
      {
        id: 'office-delivery',
        role: 'presented_files',
        files: [
          {
            path: '/project/slides.pptx',
            displayPath: 'slides.pptx',
            bytes: 456,
            office: {
              artifactId: 'artifact-1',
              outputId: 'output-1',
              kind: 'pptx',
              revision: 4,
              sha256: 'b'.repeat(64),
              warnings: ['text_may_overflow'],
              checks: { schema: 'passed', content: 'passed', samples: 1, pageCount: 2 }
            }
          }
        ]
      }
    ],
    { onOpenLocalPath: () => undefined }
  )

  assert.match(markup, /PowerPoint 演示文稿/)
  assert.match(markup, /文本可能溢出/)
  assert.doesNotMatch(markup, /内容可能已更改/)
})

test('chat view shows delivered files after a later tool call and closing reply', () => {
  const markup = renderChat(
    [
      { id: 'user-1', role: 'user', content: 'make a figure' },
      { id: 'summary-1', role: 'assistant', content: 'Two comparisons are complete.' },
      {
        id: 'delivery-1',
        role: 'presented_files',
        files: [{ path: '/project/figure.png', displayPath: 'figure.png', bytes: 123 }]
      },
      {
        id: 'tool-1',
        role: 'tool',
        toolName: 'present_files',
        argsPreview: '',
        argsJson: '',
        output: 'done',
        status: 'done'
      },
      { id: 'assistant-final', role: 'assistant', content: 'Figure is ready.' }
    ],
    { onOpenLocalPath: () => undefined }
  )

  assert.match(markup, /Figure is ready/)
  assert.match(markup, /aria-label="预览交付文件 figure\.png"/)
  assert.ok(markup.indexOf('Figure is ready') < markup.indexOf('预览交付文件 figure.png'))
})

test('chat composer offers a selected and disabled plan review mode', () => {
  const selected = renderChat([], { planReviewEnabled: true, onTogglePlanReview: () => undefined })
  assert.match(selected, /aria-label="先计划并等待评审"/)
  assert.match(selected, /aria-pressed="true"/)
  const disabled = renderChat([], { disablePlanReview: true, onTogglePlanReview: () => undefined })
  const button = disabled.match(/<button[^>]*aria-label="先计划并等待评审"[^>]*>/)?.[0]
  assert.ok(button)
  assert.match(button, /disabled/)
})

test('chat view shows only retry for failed user message turns', () => {
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
      id: 'run-failed',
      role: 'run',
      event: 'failed',
      runId: 'run-1',
      createdAt: '2026-09-07T00:00:03.000Z'
    },
    { id: 'error-1', role: 'error', content: 'Provider failed', runId: 'run-1' }
  ])

  assert.match(markup, /aria-label="重试消息"/)
  assert.doesNotMatch(markup, /aria-label="复制消息"/)
  assert.doesNotMatch(markup, /aria-label="编辑消息"/)
})

test('chat view extracts suggested next action placeholders from assistant messages', () => {
  assert.equal(
    suggestedNextActionPlaceholderFromMessages([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '完成。\n\n推荐下一步：\n- 运行 notebook 并检查图表。'
      }
    ]),
    '运行 notebook 并检查图表。'
  )
  assert.equal(
    suggestedNextActionPlaceholderFromMessages([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Done.\n\nRecommended next steps, in order: (1) run the visual pass.'
      }
    ]),
    'run the visual pass.'
  )
  assert.equal(
    suggestedNextActionPlaceholderFromMessages([
      {
        id: 'user-1',
        role: 'user',
        content: 'Y轴超过30的按30算，重新调整火山图'
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '已完成。3 个火山图 cell 全部调整。Notebook 已重新执行验证，0 错误。'
      }
    ]),
    null
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

  assert.match(markup, /正在处理，已耗时 5 秒/)
  assert.match(markup, /aria-label="展开处理过程"/)
  assert.doesNotMatch(markup, /处理过程：/)
  assert.doesNotMatch(markup, /rg provider/)
  assert.match(markup, /aria-label="执行中"/)
  assert.match(markup, /role="progressbar"/)
  assert.doesNotMatch(markup, />执行中</)
})

test('chat view keeps streaming progress text inside the active processing fold', () => {
  const markup = withMockedNow('2026-09-07T00:00:05.000Z', () =>
    renderChat(
      [
        { id: 'user-1', role: 'user', content: '分析 notebook' },
        {
          id: 'thinking-1',
          role: 'thinking',
          content: '先确认 notebook 状态。',
          createdAt: '2026-09-07T00:00:00.000Z',
          completedAt: '2026-09-07T00:00:02.000Z',
          durationMs: 2000
        },
        {
          id: 'assistant-progress-1',
          role: 'assistant',
          content: '当前正在补充分析代码。',
          createdAt: '2026-09-07T00:00:03.000Z'
        }
      ],
      { isGenerating: true, currentRunStartedAt: '2026-09-07T00:00:00.000Z' }
    )
  )

  assert.match(markup, /正在处理，已耗时 5 秒/)
  assert.match(markup, /aria-label="展开处理过程"/)
  assert.doesNotMatch(markup, /当前正在补充分析代码。/)
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

  assert.match(markup, /正在处理，已耗时 30 秒/)
  assert.doesNotMatch(markup, /正在处理，已耗时 10 秒/)
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

  assert.match(markup, /正在处理，已耗时 5 秒/)
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
  assert.equal(toolActionKind('office_read', 'Sheet1!A1:B3', '{"range":"A1:B3"}'), 'read')
  assert.equal(
    toolActionKind('office_apply', '修改 Word 段落', '{"type":"set_paragraph_text"}'),
    'edit'
  )
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
  assert.equal(
    toolActionKind('notebook.run_cell', 'eda.ipynb', '{"path":"eda.ipynb","cellId":"cell-2"}'),
    'notebook'
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

  const notebookMarkup = renderToolCall({
    id: 'tool-notebook',
    role: 'tool',
    toolName: 'notebook.run_cell',
    argsPreview: 'eda.ipynb',
    argsJson: '{"path":"eda.ipynb","cellId":"cell-2"}',
    output: 'Ran Cell 2',
    status: 'done',
    notebook: {
      kind: 'notebook_cell_executed',
      relativePath: 'eda.ipynb',
      cellNumber: 2,
      cellId: 'cell-2',
      cellType: 'code',
      executionState: 'idle',
      executionCount: 7,
      summary: 'Ran Cell 2'
    }
  })

  assert.match(notebookMarkup, /aria-label="分析"/)
  assert.match(notebookMarkup, /已运行 Cell/)
  assert.match(notebookMarkup, /Cell 2/)
  assert.match(notebookMarkup, /eda\.ipynb/)
  assert.doesNotMatch(notebookMarkup, /cell-2/)
  assert.doesNotMatch(notebookMarkup, />notebook\.run_cell</)
  assert.doesNotMatch(notebookMarkup, /aria-label="跳转到 cell"/)

  const notebookJumpMarkup = renderToolCall(
    {
      id: 'tool-notebook',
      role: 'tool',
      toolName: 'notebook.update_cell',
      argsPreview: 'eda.ipynb',
      argsJson: '{"path":"eda.ipynb","cellId":"cell-2"}',
      output: 'Updated Cell 2',
      status: 'done',
      notebook: {
        kind: 'notebook_cell_updated',
        path: '/project/eda.ipynb',
        relativePath: 'eda.ipynb',
        cellNumber: 2,
        cellId: 'cell-2',
        cellType: 'code',
        summary: 'Updated Cell 2'
      }
    },
    {
      onJumpToNotebookCell: () => undefined
    }
  )

  assert.match(notebookJumpMarkup, /aria-label="跳转到 cell"/)

  const notebookGroupMarkup = renderToolGroup([
    {
      id: 'tool-notebook',
      role: 'tool',
      toolName: 'notebook.save',
      argsPreview: 'eda.ipynb',
      argsJson: '{"path":"eda.ipynb"}',
      output: 'Saved eda.ipynb',
      status: 'done',
      notebook: {
        kind: 'notebook_saved',
        relativePath: 'eda.ipynb',
        summary: 'Saved eda.ipynb'
      }
    }
  ])

  assert.match(notebookGroupMarkup, /已操作 Notebook/)

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

test('office approval labels distinguish PowerPoint slide creation and text changes', () => {
  assert.equal(
    toolApprovalLabel('office_apply', '新增幻灯片到演示文稿末尾；标题：「封面」'),
    '新增 PowerPoint 幻灯片'
  )
  assert.equal(
    toolApprovalLabel('office_apply', '修改第 2 页标题（256/2）：「旧」→「新」'),
    '修改 PowerPoint 文本'
  )
})

test('Office delivery uses a write action and a dedicated approval label', () => {
  assert.equal(toolActionKind('office_deliver', '交付 report.xlsx', '{}'), 'edit')
  assert.equal(
    toolApprovalLabel('office_deliver', '将在当前工作区写入新的 Excel 表格'),
    '交付 Office 文件'
  )
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

  assert.match(
    markup,
    /aria-label="添加文件、智能体、Skill 或开发者扩展"[\s\S]*aria-label="选择权限模式/
  )
})

test('chat view uses the suggested next action as a passive placeholder', () => {
  const markup = renderChat([
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '完成。\n\n下一步操作：\n1. 继续生成验证图表。'
    }
  ])

  assert.match(markup, /placeholder="继续生成验证图表。"/)
  assert.match(markup, /data-phi-placeholder-kind="suggested-next-action"/)
  assert.doesNotMatch(
    readFileSync('src/renderer/src/features/chat/ChatView.tsx', 'utf8'),
    /applySuggestedNextAction|onMouseDown=\{applySuggestedNextAction\}/
  )
})

test('chat composer places context usage between the provider and send controls', () => {
  const markup = renderChat([], {
    contextUsageTarget: {
      sessionPath: 'phi-session:session-a',
      phiSessionId: 'session-a',
      sessionGeneration: 0
    }
  })

  assert.match(markup, /data-phi-context-usage="unavailable"/)
  assert.match(markup, /正在读取上下文/)
  const modelPosition = markup.indexOf('aria-label="选择模型')
  const contextPosition = markup.indexOf('data-phi-context-usage="unavailable"')
  const sendPosition = markup.indexOf('data-phi-composer-action="send"')
  assert.ok(modelPosition >= 0 && modelPosition < contextPosition && contextPosition < sendPosition)
  assert.doesNotMatch(markup, /aria-label="压缩当前会话上下文"|aria-label="自动压缩设置"/)
})

test('finished background jobs render as one clickable line without the stored details', () => {
  const markup = renderChat([
    {
      id: 'wrapper-done',
      role: 'warning',
      content: 'Wrapper 运行已完成\n输出目录：/data/qc\n运行编号：wrun_abc',
      backgroundJobNotice: { state: 'completed' }
    }
  ])

  assert.match(markup, /<button[^>]*>Wrapper 运行已完成 · 查看后台任务<\/button>/)
  assert.doesNotMatch(markup, /\/data\/qc|wrun_abc/)
})

test('chat timeline shows compaction method, token counts and expandable full summary', () => {
  const markup = renderChat([
    {
      id: 'compact-1',
      role: 'warning',
      content: '上下文已压缩，较早内容已汇总给模型；聊天时间线会继续保留可见历史。',
      contextCompaction: {
        action: 'remote',
        tokensBefore: 24000,
        tokensAfter: 5000,
        shortSummary: '简短摘要',
        summary: '完整摘要保留所有关键决策。'
      }
    },
    {
      id: 'compact-2',
      role: 'error',
      content: '上下文压缩失败：provider rejected summary',
      contextCompaction: { action: 'manual' }
    }
  ])

  assert.match(markup, /自动压缩 · 服务端/)
  assert.match(markup, /压缩前 24,000 tokens → 压缩后 约 5,000 tokens/)
  assert.match(markup, /<details/)
  assert.match(markup, /查看完整摘要/)
  assert.match(markup, /完整摘要保留所有关键决策。/)
  assert.match(markup, /手动压缩/)
  assert.match(markup, /provider rejected summary/)
})

test('chat view does not reuse the previous user action when the assistant only reports completion', () => {
  const markup = renderChat([
    {
      id: 'user-1',
      role: 'user',
      content: '把 SbatchRunner 接入 runs.ts 的提交流程'
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '已完成，验证通过。'
    }
  ])

  assert.match(markup, /placeholder="输入消息，Enter 发送，Shift\+Enter 换行"/)
  assert.match(markup, /data-phi-placeholder-kind="default"/)
  assert.doesNotMatch(markup, /placeholder="[^"]*SbatchRunner/)
  assert.doesNotMatch(markup, /data-phi-placeholder-kind="suggested-next-action"/)
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
  assert.match(markup, /data-phi-provider-icon="moonshot"[\s\S]*<svg/)
  assert.match(markup, /data-phi-composer-action="send" data-phi-composer-size="32"/)
  assert.doesNotMatch(markup, />权限 Auto</)
  assert.doesNotMatch(markup, />High</)
  assert.doesNotMatch(markup, />Kimi Coding</)
  assert.doesNotMatch(markup, /输入消息，Enter 发送/)
})

test('Cursor models display the Cursor provider icon', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ProviderModelIcon, { providerId: 'cursor' })
    )
  )

  assert.match(markup, /data-phi-provider-icon="cursor"/)
  assert.match(markup, /aria-label="Cursor"[\s\S]*<svg/)
})

test('composer buttons stay fixed on hover and use matching action icon sizes', () => {
  const surface = composerSurfaceSx({ compact: false, dragActive: false })
  assert.match(JSON.stringify(surface), /MuiButton-root:hover[^}]*transform":"none"/)

  const source = readFileSync('src/renderer/src/features/chat/ChatView.tsx', 'utf8')
  assert.match(source, /<GoPaperAirplane size=\{COMPOSER_ICON_SIZE\}/)
  assert.match(source, /<GoSquare size=\{COMPOSER_ICON_SIZE\}/)
  assert.match(source, /data-phi-composer-action="send"[\s\S]*?bgcolor: 'transparent'/)
  assert.doesNotMatch(source, /spinHourglass|GoHourglass/)

  const modelControlSource = readFileSync(
    'src/renderer/src/components/chat/ChatComposerControls.tsx',
    'utf8'
  ).split('export function ModelSelectorControl')[1]
  assert.equal((modelControlSource.match(/disableRipple/g) ?? []).length, 2)
  assert.match(modelControlSource, /'&:hover': \{ bgcolor: 'action.hover' \}/)
})

test('chat view keeps compact composer icon buttons at the declared outer size', () => {
  const chatViewSource = readFileSync('src/renderer/src/features/chat/ChatView.tsx', 'utf8')
  const controlStylesSource = readFileSync(
    'src/renderer/src/components/chat/composerControlStyles.ts',
    'utf8'
  )

  assert.match(
    controlStylesSource,
    /const compactComposerIconButtonSx = \{[\s\S]*?boxSizing: 'border-box'[\s\S]*?p: 0[\s\S]*?\} as const/
  )
  assert.match(
    chatViewSource,
    /data-phi-composer-action="send"[\s\S]*?boxSizing: 'border-box'[\s\S]*?p: 0/
  )
  assert.match(
    chatViewSource,
    /data-phi-composer-action="stop"[\s\S]*?boxSizing: 'border-box'[\s\S]*?p: 0/
  )
})

test('chat view replaces send with one square stop control', () => {
  const compactMarkup = renderChat([], { compactComposerControls: true, isGenerating: true })
  const regularMarkup = renderChat([], { isGenerating: true })

  assert.match(compactMarkup, /data-phi-composer-action="stop" data-phi-composer-size="32"/)
  assert.match(regularMarkup, /data-phi-composer-action="stop" data-phi-composer-size="40"/)
  assert.equal((regularMarkup.match(/data-phi-composer-action=/g) ?? []).length, 1)
  assert.doesNotMatch(
    regularMarkup,
    /data-phi-composer-action="queue"|data-phi-composer-action="send"/
  )
  assert.match(regularMarkup, /title="运行中，点击停止生成"/)
})

test('agent execution details scroll instead of flattening every child step into the chat flow', () => {
  const source = readFileSync('src/renderer/src/components/AgentExecutionCard.tsx', 'utf8')

  assert.match(source, /data-phi-agent-execution-scroll="true"/)
  assert.match(source, /maxHeight: AGENT_EXECUTION_DETAIL_MAX_HEIGHT/)
  assert.match(source, /overflowY: 'auto'/)
  assert.match(source, /aria-label="折叠 Agent 执行"[\s\S]*<ExpandLessIcon/)
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

test('remote specialist approval shows the real host, project and path without the local anchor', () => {
  const markup = renderChat([], {
    pendingApproval: {
      requestId: 'approval-remote',
      sessionPath: '/phi/sessions/remote',
      projectName: 'Cluster project',
      cwd: 'ssh://cluster-a/project',
      toolName: 'edit',
      summary: 'SSH cluster-a · 项目 /project；修改已读取且未变化的文件。\nnote.txt'
    }
  })
  assert.match(markup, /Cluster project/)
  assert.match(markup, /ssh:\/\/cluster-a\/project/)
  assert.match(markup, /note\.txt/)
  assert.match(markup, /修改文件/)
  assert.doesNotMatch(markup, /remote-project-anchors/)
})

test('chat view renders a user input request inline', () => {
  const markup = renderChat([], {
    pendingUserInteraction: {
      requestId: 'input-1',
      questions: [
        {
          header: '目标目录',
          question: '请选择目标目录策略？',
          options: [
            { label: '当前目录', description: '继续使用当前工作目录。' },
            {
              label: '新目录',
              description: '切换到用户指定的新目录。',
              preview: '/tmp/project'
            }
          ]
        },
        {
          header: '数据库',
          question: '偏好哪个通路数据库？',
          options: [
            { label: 'KEGG', description: '通路图最常用。' },
            { label: 'Reactome', description: '人工审核通路。' }
          ]
        }
      ],
      projectName: 'test',
      cwd: '/tmp/test'
    }
  })

  assert.match(markup, /等待用户输入/)
  assert.match(markup, /需要选择/)
  assert.match(markup, /1 \/ 2/)
  assert.doesNotMatch(markup, /第 1 \/ 2 题/)
  assert.match(markup, /目标目录/)
  assert.match(markup, /请选择目标目录策略/)
  assert.match(markup, /当前目录/)
  assert.match(markup, /继续使用当前工作目录。/)
  assert.match(markup, /自定义答案/)
  assert.doesNotMatch(markup, /打开会话/)
  assert.doesNotMatch(markup, /\/tmp\/test/)
  assert.match(markup, /下一步/)
  assert.doesNotMatch(markup, /偏好哪个通路数据库/)
  assert.doesNotMatch(markup, /Reactome/)
  assert.doesNotMatch(markup, /备注/)
  assert.doesNotMatch(markup, /整体备注/)
})

test('chat view shows queued prompts above the composer while a session is busy', () => {
  const markup = renderChat([], {
    isGenerating: true,
    canQueue: true,
    input: '继续下一步',
    queuedPrompts: [{ id: 'queued-1', text: '排队的下一条问题' }]
  })

  assert.match(markup, /placeholder="输入消息，Enter 加入队列，Shift\+Enter 换行"/)
  assert.doesNotMatch(markup, /aria-label="加入队列"/)
  assert.match(markup, /aria-label="停止生成"/)
  assert.match(markup, /消息队列/)
  assert.match(markup, /排队中 1 条/)
  assert.match(markup, /排队的下一条问题/)
  assert.match(markup, /aria-label="移除排队消息"/)
})

test('chat view shows a preparing placeholder for a wrapper plan tool call with no planId yet', () => {
  const markup = renderChat([
    { id: 'call-1', role: 'wrapper_plan', toolName: 'wrapper.phi_ngs_fastq_qc', status: 'running' }
  ])

  assert.match(markup, /正在准备 wrapper 计划/)
})

test('chat view shows an error state for a failed wrapper plan tool call, with no plan metadata leaked', () => {
  const markup = renderChat([
    { id: 'call-1', role: 'wrapper_plan', toolName: 'wrapper.phi_ngs_fastq_qc', status: 'error' }
  ])

  assert.match(markup, /wrapper 计划创建失败/)
  // The chat item itself never carries plan detail — only an id once resolved.
  assert.doesNotMatch(markup, /fastq-qc|multiqc|nextflow/i)
})

test('Tab on an empty input accepts the suggested next action as real text', () => {
  const tab = {
    key: 'Tab',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false
  }
  assert.equal(
    suggestedNextActionToAccept(tab, '', '列出当前可用的 wrappers'),
    '列出当前可用的 wrappers'
  )
  // Only when there is a suggestion and nothing typed yet, and only for a plain Tab.
  assert.equal(suggestedNextActionToAccept(tab, '', null), null)
  assert.equal(suggestedNextActionToAccept(tab, 'draft', '列出当前可用的 wrappers'), null)
  assert.equal(suggestedNextActionToAccept({ ...tab, key: 'Enter' }, '', 'x'), null)
  assert.equal(suggestedNextActionToAccept({ ...tab, shiftKey: true }, '', 'x'), null)
  assert.equal(suggestedNextActionToAccept({ ...tab, isComposing: true }, '', 'x'), null)
})
