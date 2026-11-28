import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import UserInteractionPanel from '../src/renderer/src/components/UserInteractionPanel'
import ToolApprovalDialog from '../src/renderer/src/components/ToolApprovalDialog'
import { McpAuthPromptCard } from '../src/renderer/src/features/chat/components/McpAuthPromptCard'
import {
  classifyMcpAuthError,
  createMcpAuthPromptDraft,
  formatMcpAuthError,
  mcpAuthPromptResponse,
  reduceMcpAuthPromptDraft,
  type McpAuthPromptRequest
} from '../src/renderer/src/features/chat/lib/mcpAuthPrompt'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import type { AgentUserInteractionRequest } from '../src/renderer/src/types'

const oauthRequest: McpAuthPromptRequest = {
  requestId: 'mcp-auth-oauth-1',
  runtimeSessionId: 'runtime-session-1',
  kind: 'oauth',
  connector: {
    id: 'composio',
    title: 'Composio',
    publisher: 'Composio',
    authorizationOrigin: 'https://connect.composio.dev',
    homepageUrl: 'https://docs.composio.dev'
  }
}

const apiKeyRequest: McpAuthPromptRequest = {
  requestId: 'mcp-auth-key-1',
  runtimeSessionId: 'runtime-session-1',
  kind: 'api-key',
  connector: {
    id: 'serpapi',
    title: 'SerpApi',
    publisher: 'SerpApi',
    obtainUrl: 'https://serpapi.com/manage-api-key',
    homepageUrl: 'https://serpapi.com/search-api'
  }
}

function renderCard(request: McpAuthPromptRequest): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpAuthPromptCard, {
        request,
        onRespond: () => undefined
      })
    )
  )
}

test.afterEach(() => setUiLanguage('en'))

test('OAuth MCP chat card renders sign-in action, external links, and Composio guidance in both languages', () => {
  setUiLanguage('en')
  const en = renderCard(oauthRequest)
  assert.match(en, /aria-label="Connector authentication required: Composio"/)
  assert.match(en, /Connector sign-in required/)
  assert.match(en, /https:\/\/connect\.composio\.dev/)
  assert.match(en, /href="https:\/\/connect\.composio\.dev"/)
  assert.match(en, /href="https:\/\/docs\.composio\.dev"/)
  assert.match(en, /After signing in to Composio/)
  assert.match(en, />Sign in with browser</)
  assert.match(en, />Skip for now</)

  setUiLanguage('zh-CN')
  const zh = renderCard(oauthRequest)
  assert.match(zh, /aria-label="连接器需要完成认证：Composio"/)
  assert.match(zh, /连接器需要登录授权/)
  assert.match(zh, /打开授权站点 ↗/)
  assert.match(zh, /服务文档 ↗/)
  assert.match(zh, /完成 Composio 登录后/)
  assert.match(zh, />打开浏览器授权登录</)
  assert.match(zh, />稍后配置</)
})

test('API-key MCP chat card renders key input, obtain-key link, and SerpApi disclosure in both languages', () => {
  setUiLanguage('en')
  const en = renderCard(apiKeyRequest)
  assert.match(en, /Connector API key required/)
  assert.match(en, /Get SerpApi API key ↗/)
  assert.match(en, /href="https:\/\/serpapi\.com\/manage-api-key"/)
  assert.match(en, /type="password"/)
  assert.match(en, /SerpApi requires sending the key once/)
  assert.match(en, />Verify and enable</)

  setUiLanguage('zh-CN')
  const zh = renderCard(apiKeyRequest)
  assert.match(zh, /连接器需要配置 API Key/)
  assert.match(zh, /获取 SerpApi API Key ↗/)
  assert.match(zh, /SerpApi 需要在一次 HTTPS 查询参数中发送密钥/)
  assert.match(zh, />验证并启用</)
})

test('UserInteractionPanel routes mcpAuth requests to McpAuthPromptCard', () => {
  setUiLanguage('zh-CN')
  const request: AgentUserInteractionRequest = {
    requestId: 'mcp-auth-route-1',
    questions: [],
    mcpAuth: {
      runtimeSessionId: 'runtime-session-1',
      kind: 'api-key',
      connector: {
        id: 'tavily',
        title: 'Tavily',
        publisher: 'Tavily',
        obtainUrl: 'https://app.tavily.com/home'
      }
    }
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(UserInteractionPanel, { request, onRespond: () => undefined })
    )
  )
  assert.match(markup, /data-phi-mcp-auth-prompt="tavily"/)
  assert.match(markup, /获取 Tavily API Key ↗/)
})

test('MCP auth responses never carry plaintext secrets and error states switch languages live', () => {
  let draft = createMcpAuthPromptDraft('req-1')
  draft = reduceMcpAuthPromptDraft(draft, { type: 'set-api-key', apiKey: 'tvly-super-secret' })
  assert.equal(draft.apiKey, 'tvly-super-secret')

  const okResponse = mcpAuthPromptResponse('req-1', 'tavily', { action: 'authenticated' })
  assert.doesNotMatch(JSON.stringify(okResponse), /tvly-super-secret/)
  assert.deepEqual(okResponse, {
    requestId: 'req-1',
    mcpAuthChoice: { action: 'authenticated' },
    answers: [
      {
        questionIndex: 0,
        question: 'mcp_auth:tavily',
        kind: 'option',
        answer: 'authenticated'
      }
    ]
  })

  const cancelResponse = mcpAuthPromptResponse('req-1', 'tavily', { action: 'cancel' })
  assert.equal(cancelResponse.cancelled, true)
  assert.deepEqual(cancelResponse.mcpAuthChoice, { action: 'cancel' })

  const timeoutError = classifyMcpAuthError(
    new Error(
      "Error invoking remote method 'mcp:authorizeFeatured': Error: Authorization timed out"
    )
  )
  setUiLanguage('en')
  assert.match(formatMcpAuthError(timeoutError), /within two minutes/)
  setUiLanguage('zh-CN')
  assert.match(formatMcpAuthError(timeoutError), /两分钟/)
})

test('ToolApprovalDialog localizes find_skills external search approvals in English and Simplified Chinese', () => {
  const request = {
    requestId: 'approval-find-skills-1',
    toolName: 'find_skills',
    summary: '搜索关键词：scanpy'
  }
  setUiLanguage('en')
  const en = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ToolApprovalDialog, { request, onRespond: () => undefined })
    )
  )
  assert.match(en, /Search external skills \(unverified\)/)
  assert.match(en, />Approve</)
  assert.match(en, />Deny</)

  setUiLanguage('zh-CN')
  const zh = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ToolApprovalDialog, { request, onRespond: () => undefined })
    )
  )
  assert.match(zh, /搜索外部技能（第三方未验证）/)
  assert.match(zh, />批准</)
  assert.match(zh, />拒绝</)
})
