import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildBrowserTool } from '../src/main/agent/browser/browser-tool'
import { buildPaletteRecommendationTool } from '../src/main/agent/palettes/tools'
import { buildAskUserQuestionCustomTools } from '../src/main/agent/user-interaction-tools'
import type { BrowserOutcome } from '../src/shared/browserTypes'

test('remote A tools execute without reading or forwarding the local project anchor', async () => {
  const anchor = mkdtempSync(join(tmpdir(), 'phi-remote-a-tools-'))
  const sentinel = join(anchor, 'sentinel.txt')
  writeFileSync(sentinel, 'untouched')
  const hostRequests: unknown[] = []
  const ctx = {
    sessionManager: {
      getCwd(): never {
        throw new Error(`local anchor must not be read: ${anchor}`)
      }
    }
  } as never
  try {
    const browser = buildBrowserTool('runtime-1', async (request) => {
      hostRequests.push(request)
      return browserOutcome()
    })
    const browserResult = await browser.execute(
      'browser-call',
      { action: 'open', url: 'https://example.org' },
      undefined,
      ctx
    )
    assert.equal(browserResult.isError, undefined)

    const [ask] = buildAskUserQuestionCustomTools('runtime-1', async (request) => {
      hostRequests.push(request)
      return { answers: [], cancelled: true }
    })
    await ask.execute(
      'ask-call',
      {
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
      },
      undefined,
      ctx
    )

    const palette = buildPaletteRecommendationTool()
    const paletteResult = await palette.execute(
      'palette-call',
      { use: 'categorical', limit: 1 },
      undefined,
      ctx
    )
    assert.equal(paletteResult.isError, undefined)
    assert.doesNotMatch(JSON.stringify(hostRequests), new RegExp(anchor.replaceAll('/', '\\/')))
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched')
  } finally {
    rmSync(anchor, { recursive: true, force: true })
  }
})

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
