import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import UserInteractionPanel from '../src/renderer/src/components/UserInteractionPanel'
import type { AgentUserInteractionRequest } from '../src/renderer/src/types'
import { MissingToolPromptCard } from '../src/renderer/src/features/chat/components/MissingToolPromptCard'
import {
  createMissingToolPromptDraft,
  missingToolPromptDraftForRequest,
  missingToolPromptResponse,
  reduceMissingToolPromptDraft,
  type MissingToolPromptRequest
} from '../src/renderer/src/features/chat/lib/missingToolPrompt'

const nextflowRequest: MissingToolPromptRequest = {
  requestId: 'missing-tool-1',
  runtimeSessionId: 'runtime-session-1',
  tool: { id: 'nextflow', label: 'Nextflow' },
  candidates: [
    {
      path: '/data/lab/miniconda3/envs/nextflow/bin/nextflow',
      source: 'conda',
      version: '24.10.4'
    },
    {
      path: '/opt/nextflow/bin/nextflow',
      source: 'common'
    }
  ],
  install: {
    environment: 'phi-nextflow',
    location: '/data/lab/.phi/runtime/envs/phi-nextflow',
    packages: ['nextflow', 'openjdk >=17'],
    approximateSize: '650 MB'
  }
}

function render(request: MissingToolPromptRequest): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MissingToolPromptCard, {
        request,
        onRespond: () => undefined
      })
    )
  )
}

test.afterEach(() => setUiLanguage('en'))

test('missing-tool chat card renders candidates, path entry, install summary, and cancel in English', () => {
  setUiLanguage('en')
  const markup = render(nextflowRequest)

  assert.match(markup, /aria-label="Required tool not found: Nextflow"/)
  assert.ok(markup.includes('/data/lab/miniconda3/envs/nextflow/bin/nextflow'))
  assert.match(markup, /Conda environment/)
  assert.match(markup, /24\.10\.4/)
  assert.match(markup, /Enter a path/)
  assert.match(markup, /Environment folder or absolute executable path/)
  assert.match(markup, /Install a new environment/)
  assert.match(markup, /What/)
  assert.match(markup, /nextflow, openjdk &gt;=17/)
  assert.match(markup, /Where/)
  assert.ok(markup.includes('/data/lab/.phi/runtime/envs/phi-nextflow'))
  assert.match(markup, /Approximate size/)
  assert.match(markup, /650 MB/)
  assert.match(markup, />Cancel</)
})

test('missing-tool chat card localizes its controls and source labels in Simplified Chinese', () => {
  setUiLanguage('zh-CN')
  const markup = render(nextflowRequest)

  assert.match(markup, /aria-label="缺少必需工具：Nextflow"/)
  assert.match(markup, /找到的候选路径/)
  assert.match(markup, /Conda 环境/)
  assert.match(markup, /输入路径/)
  assert.match(markup, /环境目录或可执行文件的绝对路径/)
  assert.match(markup, /安装新环境/)
  assert.match(markup, /安装内容/)
  assert.match(markup, /安装位置/)
  assert.match(markup, /预计大小/)
  assert.match(markup, />取消</)
})

test('a rejected path is shown with its reason when Phi asks again', () => {
  setUiLanguage('en')
  const markup = render({
    ...nextflowRequest,
    rejectedPath: { path: '/data/wrong', reason: 'not-executable' }
  })
  assert.ok(markup.includes('/data/wrong'))
  assert.match(markup, /was not accepted/)
  assert.match(markup, /no executable/)

  setUiLanguage('zh-CN')
  const zh = render({
    ...nextflowRequest,
    rejectedPath: { path: '/data/wrong', reason: 'not-executable' }
  })
  assert.match(zh, /未被接受/)
})

test('container-runtime prompts never offer installation', () => {
  setUiLanguage('en')
  const markup = render({
    ...nextflowRequest,
    tool: { id: 'apptainer', label: 'Apptainer' }
  })

  assert.match(markup, /Apptainer/)
  assert.match(markup, /Enter a path/)
  assert.doesNotMatch(markup, /Install a new environment/)
  assert.doesNotMatch(markup, /650 MB/)
})

test('generic user interaction entry point selects the feature-owned missing-tool card', () => {
  setUiLanguage('en')
  const request = {
    requestId: nextflowRequest.requestId,
    questions: [],
    missingTool: {
      tool: nextflowRequest.tool,
      candidates: nextflowRequest.candidates,
      install: nextflowRequest.install
    }
  } as unknown as AgentUserInteractionRequest
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(UserInteractionPanel, { request, onRespond: () => undefined })
    )
  )

  assert.match(markup, /data-phi-missing-tool-prompt="nextflow"/)
  assert.match(markup, /Install a new environment/)
})

test('missing-tool choices map to the existing user-interaction response envelope', () => {
  assert.deepEqual(
    missingToolPromptResponse('request-1', 'nextflow', {
      kind: 'candidate',
      path: '/opt/nextflow/bin/nextflow'
    }),
    {
      requestId: 'request-1',
      missingToolChoice: {
        action: 'candidate',
        path: '/opt/nextflow/bin/nextflow'
      },
      answers: [
        {
          questionIndex: 0,
          question: 'missing_tool:nextflow',
          kind: 'option',
          answer: '/opt/nextflow/bin/nextflow'
        }
      ]
    }
  )
  assert.deepEqual(
    missingToolPromptResponse('request-1', 'nextflow', {
      kind: 'path',
      path: '/custom/envs/nextflow'
    }),
    {
      requestId: 'request-1',
      missingToolChoice: {
        action: 'path',
        path: '/custom/envs/nextflow'
      },
      answers: [
        {
          questionIndex: 0,
          question: 'missing_tool:nextflow',
          kind: 'custom',
          answer: '/custom/envs/nextflow'
        }
      ]
    }
  )
  assert.deepEqual(missingToolPromptResponse('request-1', 'nextflow', { kind: 'install' }), {
    requestId: 'request-1',
    missingToolChoice: { action: 'install' },
    answers: [
      {
        questionIndex: 0,
        question: 'missing_tool:nextflow',
        kind: 'option',
        answer: 'install'
      }
    ]
  })
  assert.deepEqual(missingToolPromptResponse('request-1', 'nextflow', { kind: 'cancel' }), {
    requestId: 'request-1',
    answers: [],
    cancelled: true,
    missingToolChoice: { action: 'cancel' }
  })
})

test('path draft survives a live language change', () => {
  const englishDraft = reduceMissingToolPromptDraft(createMissingToolPromptDraft('request-1'), {
    type: 'enter-path',
    path: '/custom/envs/nextflow'
  })

  setUiLanguage('zh-CN')
  const chineseDraft = missingToolPromptDraftForRequest('request-1', englishDraft)

  assert.equal(chineseDraft, englishDraft)
  assert.equal(chineseDraft.path, '/custom/envs/nextflow')
})
