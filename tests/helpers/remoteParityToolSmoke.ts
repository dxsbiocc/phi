import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ModelRegistry,
  SessionManager,
  Settings,
  discoverAuthStorage,
  type CustomTool
} from '@oh-my-pi/pi-coding-agent'
import { createAgentSession } from '@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim'
import { initializeExtensions } from '@oh-my-pi/pi-coding-agent/modes/runtime-init'

import { createRemoteProjectToolGuardExtension } from '../../src/main/agent/agents/remote-project-tool-guard'
import { buildBrowserTool } from '../../src/main/agent/browser/browser-tool'
import { buildRemotePresentFilesTool } from '../../src/main/agent/deliverables/remote-present-tool'
import { buildRemoteProjectDownloadTool } from '../../src/main/agent/download/remote-project-download-tool'
import { buildPaletteRecommendationTool } from '../../src/main/agent/palettes/tools'
import { buildAskUserQuestionCustomTools } from '../../src/main/agent/user-interaction-tools'
import type { BrowserOutcome } from '../../src/shared/browserTypes'

const agentDir = mkdtempSync(join(tmpdir(), 'phi-remote-parity-smoke-'))
const anchor = join(agentDir, 'remote-anchor')
mkdirSync(anchor)
writeFileSync(join(anchor, 'sentinel.txt'), 'untouched')

try {
  const authStorage = await discoverAuthStorage(agentDir)
  const settings = await Settings.init({ cwd: agentDir, agentDir })
  settings.override('web_search.enabled', true)
  const hostRequests: unknown[] = []
  const tools: CustomTool[] = [
    buildBrowserTool('runtime-1', async (request) => {
      hostRequests.push(request)
      return browserOutcome()
    }),
    buildPaletteRecommendationTool(),
    ...buildAskUserQuestionCustomTools('runtime-1', async (request) => {
      hostRequests.push(request)
      return { answers: [], cancelled: true }
    }),
    buildRemotePresentFilesTool('runtime-1', async (request) => {
      hostRequests.push(request)
      return {
        files: [{ path: 'ssh://cluster-a/project/report.txt', displayPath: 'report.txt', bytes: 4 }]
      }
    }),
    buildRemoteProjectDownloadTool(async (request) => {
      hostRequests.push(request)
      return {
        path: 'ssh://cluster-a/project/data.txt',
        displayPath: 'data.txt',
        bytes: 4
      }
    })
  ]
  const names = ['web_search', ...tools.map((tool) => tool.name)]
  const result = await createAgentSession({
    agentId: 'phi-remote-parity-smoke',
    agentDisplayName: 'Smoke',
    cwd: agentDir,
    agentDir,
    settings,
    authStorage,
    modelRegistry: new ModelRegistry(authStorage),
    sessionManager: SessionManager.inMemory(agentDir),
    customTools: tools,
    toolNames: names,
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    enableMCP: false,
    enableLsp: false,
    extensions: [createRemoteProjectToolGuardExtension()]
  })
  await initializeExtensions(result.session, {
    reportSendError: () => undefined,
    reportRuntimeError: () => undefined
  })
  const registered = result.session.getAllToolInfos().map((tool) => tool.name)
  for (const name of names) {
    if (!registered.includes(name)) throw new Error(`Remote parity smoke lost ${name}`)
  }
  const active = (
    result.session as unknown as {
      agent: {
        state: {
          tools: Array<{
            name: string
            execute: (...args: unknown[]) => Promise<{ isError?: boolean }>
          }>
        }
      }
    }
  ).agent.state.tools
  await execute(active, 'browser', { action: 'open', url: 'https://example.org' })
  await execute(active, 'palette_suggest', { use: 'categorical', limit: 1 })
  await execute(active, 'ask_user_question', {
    questions: [
      {
        header: 'Mode',
        question: 'Continue?',
        options: [
          { label: 'Yes (Recommended)', description: 'Continue.' },
          { label: 'No', description: 'Stop.' }
        ]
      }
    ]
  })
  await execute(active, 'present_files', { files: [{ path: 'report.txt' }] })
  await execute(active, 'download_file', { url: 'https://example.org/data.txt' })
  if (readFileSync(join(anchor, 'sentinel.txt'), 'utf8') !== 'untouched') {
    throw new Error('Remote parity tools modified the local anchor sentinel')
  }
  if (existsSync(join(anchor, 'report.txt')) || existsSync(join(anchor, 'data.txt'))) {
    throw new Error('Remote parity tools wrote through the local anchor')
  }
  if (JSON.stringify(hostRequests).includes(anchor)) {
    throw new Error('Remote parity tools forwarded the local anchor')
  }
  process.stdout.write(`${JSON.stringify({ registered: names, requests: hostRequests.length })}\n`)
  await result.session.dispose()
} finally {
  rmSync(agentDir, { recursive: true, force: true })
}

async function execute(
  tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ isError?: boolean }> }>,
  name: string,
  input: unknown
): Promise<void> {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Missing active tool ${name}`)
  const result = await tool.execute(
    `${name}-call`,
    input,
    undefined,
    {},
    new AbortController().signal
  )
  if (result.isError && name !== 'ask_user_question') throw new Error(`${name} failed`)
}

function browserOutcome(): BrowserOutcome {
  return {
    ok: true,
    snapshot: {
      sessionId: 'runtime-1',
      activeTabId: 'tab-1',
      revision: 1,
      capabilities: {
        presentation: 'native',
        screenshot: true,
        coordinateInput: false,
        semanticInspection: false,
        downloads: false,
        recording: false,
        persistentProfile: false
      },
      tabs: [
        {
          id: 'tab-1',
          title: 'Example',
          url: 'https://example.org',
          origin: 'https://example.org',
          phase: 'ready',
          canGoBack: false,
          canGoForward: false,
          isAgentControlled: true,
          documentRevision: 1
        }
      ]
    }
  }
}
