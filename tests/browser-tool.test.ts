import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBrowserTool } from '../src/main/agent/browser/browser-tool'
import { BrowserToolHostCoordinator } from '../src/main/agent/browser/browser-tool-host'
import type { BrowserOutcome } from '../src/shared/browserTypes'

function successfulOutcome(): BrowserOutcome {
  return {
    ok: true,
    snapshot: {
      sessionId: 'phi-session-1',
      activeTabId: 'tab-1',
      revision: 3,
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
          url: 'https://example.test/path?token=secret#private',
          origin: 'https://example.test',
          phase: 'ready',
          canGoBack: false,
          canGoForward: false,
          isAgentControlled: true,
          documentRevision: 2
        }
      ]
    }
  }
}

test('browser tool exposes one strict action-discriminated open and snapshot schema', () => {
  const tool = buildBrowserTool('runtime-session-1', async () => {
    throw new Error('not called')
  })

  assert.equal(tool.name, 'browser')
  assert.equal(tool.strict, true)
  assert.equal(tool.loadMode, 'essential')
  assert.equal(tool.approval, 'read')
  assert.deepEqual(
    (
      tool.parameters as { oneOf?: Array<{ properties?: { action?: { enum?: string[] } } }> }
    ).oneOf?.map((variant) => variant.properties?.action?.enum?.[0]),
    ['open', 'open', 'snapshot', 'snapshot']
  )
})

test('browser open defaults to a dedicated tab and forwards trusted runtime origin and tool call', async () => {
  const calls: unknown[] = []
  const tool = buildBrowserTool(
    'runtime-session-1',
    async (request) => {
      calls.push(request)
      return successfulOutcome()
    },
    { requestId: () => 'browser-request-1' }
  )

  const result = await tool.execute(
    'real-tool-call-1',
    { action: 'open', url: 'https://example.test' },
    undefined,
    {} as never
  )

  assert.deepEqual(calls, [
    {
      originSessionId: 'runtime-session-1',
      requestId: 'browser-request-1',
      toolCallId: 'real-tool-call-1',
      command: {
        type: 'open',
        requestId: 'browser-request-1',
        url: 'https://example.test'
      }
    }
  ])
  assert.equal(result.isError, undefined)
  assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /tab-1/)
})

test('browser open only navigates a current tab when revision binding is explicit', async () => {
  const calls: unknown[] = []
  const tool = buildBrowserTool(
    'runtime-session-1',
    async (request) => {
      calls.push(request)
      return successfulOutcome()
    },
    { requestId: () => 'browser-request-2' }
  )

  await tool.execute(
    'real-tool-call-2',
    {
      action: 'open',
      target: 'current',
      tabId: 'human-tab-1',
      expectedDocumentRevision: 7,
      url: 'https://example.test/next'
    },
    undefined,
    {} as never
  )

  assert.deepEqual(calls, [
    {
      originSessionId: 'runtime-session-1',
      requestId: 'browser-request-2',
      toolCallId: 'real-tool-call-2',
      command: {
        type: 'navigate',
        requestId: 'browser-request-2',
        tabId: 'human-tab-1',
        expectedDocumentRevision: 7,
        requireActive: true,
        url: 'https://example.test/next'
      }
    }
  ])
})

test('browser snapshot returns compact state plus PNG without duplicating image data in details', async () => {
  const tool = buildBrowserTool(
    'runtime-session-1',
    async () => ({
      ...successfulOutcome(),
      screenshot: {
        mediaType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUg==',
        width: 800,
        height: 600,
        tabId: 'tab-1',
        url: 'https://example.test/path?token=secret',
        documentRevision: 2
      }
    }),
    { requestId: () => 'browser-request-3' }
  )

  const result = await tool.execute(
    'real-tool-call-3',
    { action: 'snapshot', tabId: 'tab-1' },
    undefined,
    {} as never
  )

  assert.deepEqual(result.content[1], {
    type: 'image',
    data: 'iVBORw0KGgoAAAANSUhEUg==',
    mimeType: 'image/png'
  })
  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  assert.match(text, /Title: Example/)
  assert.match(text, /Document revision: 2/)
  assert.match(text, /Image: 800×600 pixels/)
  assert.doesNotMatch(text, /token=secret/)
  assert.doesNotMatch(JSON.stringify(result.details), /iVBOR/)
  assert.deepEqual((result.details as { screenshot?: unknown }).screenshot, {
    tabId: 'tab-1',
    width: 800,
    height: 600,
    documentRevision: 2
  })
})

test('browser snapshot only requests current human tab control with explicit revision binding', async () => {
  const calls: unknown[] = []
  const tool = buildBrowserTool(
    'runtime-session-1',
    async (request) => {
      calls.push(request)
      return {
        ...successfulOutcome(),
        screenshot: {
          mediaType: 'image/png',
          data: 'png',
          width: 10,
          height: 20,
          tabId: 'tab-1',
          url: 'https://example.test',
          documentRevision: 2
        }
      }
    },
    { requestId: () => 'browser-request-current-snapshot' }
  )

  await tool.execute(
    'snapshot-current-tool',
    {
      action: 'snapshot',
      target: 'current',
      tabId: 'tab-1',
      expectedDocumentRevision: 2
    },
    undefined,
    {} as never
  )

  assert.deepEqual(calls, [
    {
      originSessionId: 'runtime-session-1',
      requestId: 'browser-request-current-snapshot',
      toolCallId: 'snapshot-current-tool',
      command: {
        type: 'snapshot',
        requestId: 'browser-request-current-snapshot',
        tabId: 'tab-1',
        expectedDocumentRevision: 2,
        requireActive: true
      }
    }
  ])
})

test('browser tool forwards in-flight cancellation and removes the listener after completion', async () => {
  let finish: ((value: BrowserOutcome) => void) | undefined
  const cancellations: unknown[] = []
  const tool = buildBrowserTool(
    'runtime-session-1',
    () =>
      new Promise<BrowserOutcome>((resolve) => {
        finish = resolve
      }),
    {
      requestId: () => 'browser-request-4',
      cancelHost: async (identity) => {
        cancellations.push(identity)
      }
    }
  )
  const controller = new AbortController()
  const pending = tool.execute(
    'real-tool-call-4',
    { action: 'open', url: 'https://example.test' },
    undefined,
    {} as never,
    controller.signal
  )

  controller.abort()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(cancellations, [
    { originSessionId: 'runtime-session-1', requestId: 'browser-request-4' }
  ])

  finish?.(successfulOutcome())
  await pending
  controller.abort()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cancellations.length, 1)
})

test('browser tool returns bounded structured errors without leaking raw URLs', async () => {
  const tool = buildBrowserTool(
    'runtime-session-1',
    async () => ({
      ok: false,
      error: {
        code: 'NAVIGATION_FAILED',
        message: 'Failed https://example.test/path?token=secret',
        retryable: true,
        tabId: 'tab-1',
        url: 'https://example.test/path?token=secret'
      },
      snapshot: successfulOutcome().snapshot
    }),
    { requestId: () => 'browser-request-5' }
  )

  const result = await tool.execute(
    'real-tool-call-5',
    { action: 'open', url: 'https://example.test/path?token=secret' },
    undefined,
    {} as never
  )

  assert.equal(result.isError, true)
  assert.deepEqual(result.details, {
    kind: 'browser_error',
    code: 'NAVIGATION_FAILED',
    retryable: true,
    tabId: 'tab-1'
  })
  assert.doesNotMatch(JSON.stringify(result), /token=secret/)
})

test('browser tool validates direct current-tab and snapshot calls before host delivery', async () => {
  let calls = 0
  const tool = buildBrowserTool(
    'runtime-session-1',
    async () => {
      calls += 1
      return successfulOutcome()
    },
    { requestId: () => 'browser-request-invalid' }
  )

  for (const params of [
    { action: 'open', target: 'current', url: 'https://example.test', tabId: 'tab-1' },
    { action: 'snapshot', tabId: '' },
    { action: 'open', url: `https://example.test/${'x'.repeat(16 * 1024)}` }
  ]) {
    const result = await tool.execute('tool-invalid', params, undefined, {} as never)
    assert.equal(result.isError, true)
    assert.deepEqual(result.details, { kind: 'browser_error', code: 'INVALID_REQUEST' })
  }
  assert.equal(calls, 0)
})

test('browser tool reports cancellation when abort wins the host-success race', async () => {
  const controller = new AbortController()
  const tool = buildBrowserTool(
    'runtime-session-1',
    async () => {
      controller.abort()
      return successfulOutcome()
    },
    { requestId: () => 'browser-request-race', cancelHost: async () => undefined }
  )

  const result = await tool.execute(
    'tool-race',
    { action: 'open', url: 'https://example.test' },
    undefined,
    {} as never,
    controller.signal
  )

  assert.equal(result.isError, true)
  assert.deepEqual(result.details, {
    kind: 'browser_error',
    code: 'ACTION_CANCELLED',
    retryable: false
  })
})

test('browser host derives agent identity from the active runtime run', async () => {
  const calls: Array<{ input: unknown; signal?: AbortSignal }> = []
  const host = new BrowserToolHostCoordinator({
    resolveActiveRun: (originSessionId) =>
      originSessionId === 'runtime-session-1'
        ? { runId: 'trusted-run-1', cancelled: false }
        : undefined,
    executeAgent: async (input, signal) => {
      calls.push({ input, signal })
      return successfulOutcome()
    }
  })

  await host.execute({
    originSessionId: 'runtime-session-1',
    requestId: 'browser-request-6',
    toolCallId: 'real-tool-call-6',
    runId: 'forged-run',
    command: {
      type: 'open',
      requestId: 'browser-request-6',
      url: 'https://example.test'
    }
  })

  assert.deepEqual(calls[0]?.input, {
    originSessionId: 'runtime-session-1',
    runId: 'trusted-run-1',
    toolCallId: 'real-tool-call-6',
    command: {
      type: 'open',
      requestId: 'browser-request-6',
      url: 'https://example.test'
    }
  })
  assert.equal(calls[0]?.signal?.aborted, false)
  await assert.rejects(
    host.execute({
      originSessionId: 'runtime-unknown',
      requestId: 'browser-request-7',
      toolCallId: 'real-tool-call-7',
      command: { type: 'snapshot', requestId: 'browser-request-7', tabId: 'tab-1' }
    }),
    /active browser run is unavailable/i
  )
  for (const [index, command] of [
    { type: 'close', tabId: 'tab-1' },
    { type: 'history', tabId: 'tab-1', direction: 'back' },
    {
      type: 'navigate',
      tabId: 'tab-1',
      url: 'https://example.test',
      expectedDocumentRevision: 1
    },
    {
      type: 'snapshot',
      tabId: 'tab-1',
      expectedDocumentRevision: 1,
      requireActive: false
    },
    { type: 'snapshot', tabId: 'tab-1', requireActive: true },
    { type: 'open', url: 'https://example.test', tabId: 'tab-1' }
  ].entries()) {
    const requestId = `browser-request-forged-${index}`
    await assert.rejects(
      host.execute({
        originSessionId: 'runtime-session-1',
        requestId,
        toolCallId: `real-tool-call-forged-${index}`,
        command: { ...command, requestId }
      }),
      /invalid browser host request/i
    )
  }
})

test('browser host propagates cancellation before and during execution and cleans completed requests', async () => {
  const signals: AbortSignal[] = []
  let release: (() => void) | undefined
  const host = new BrowserToolHostCoordinator({
    resolveActiveRun: () => ({ runId: 'trusted-run-1', cancelled: false }),
    executeAgent: async (_input, signal) => {
      signals.push(signal)
      if (signals.length === 2) {
        await new Promise<void>((resolve) => {
          release = resolve
          signal.addEventListener('abort', resolve, { once: true })
        })
      }
      return successfulOutcome()
    },
    rememberedRequestCap: 2
  })
  const request = (requestId: string): Record<string, unknown> => ({
    originSessionId: 'runtime-session-1',
    requestId,
    toolCallId: `tool-${requestId}`,
    command: { type: 'open', requestId, url: 'https://example.test' }
  })

  host.cancel({ originSessionId: 'runtime-session-1', requestId: 'before' })
  await host.execute(request('before'))
  assert.equal(signals[0]?.aborted, true)

  const inFlight = host.execute(request('during'))
  await new Promise((resolve) => setImmediate(resolve))
  host.cancel({ originSessionId: 'runtime-session-1', requestId: 'during' })
  await inFlight
  assert.equal(signals[1]?.aborted, true)
  release?.()

  await host.execute(request('after'))
  host.cancel({ originSessionId: 'runtime-session-1', requestId: 'after' })
  await host.execute(request('after'))
  assert.equal(signals[3]?.aborted, false)
})
