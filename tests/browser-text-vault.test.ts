import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BrowserTextVault,
  installBrowserTextPreDispatchRedaction,
  withBrowserTextVaultCleanup
} from '../src/main/agent/browser/browser-text-vault'
import { buildBrowserTool } from '../src/main/agent/browser/browser-tool'
import type { BrowserOutcome } from '../src/shared/browserTypes'

const successfulOutcome: BrowserOutcome = {
  ok: true,
  snapshot: {
    sessionId: 'session-1',
    activeTabId: 'tab-1',
    revision: 1,
    capabilities: {
      presentation: 'native',
      screenshot: true,
      coordinateInput: true,
      semanticInspection: false,
      downloads: false,
      recording: false,
      persistentProfile: false
    },
    tabs: [
      {
        id: 'tab-1',
        title: 'Form',
        url: 'http://localhost:3000/form',
        origin: 'http://localhost:3000',
        phase: 'ready',
        canGoBack: false,
        canGoForward: false,
        isAgentControlled: true,
        documentRevision: 1
      }
    ]
  },
  screenshot: {
    mediaType: 'image/png',
    data: 'iVBORw0KGgo=',
    width: 1,
    height: 1,
    tabId: 'tab-1',
    url: 'http://localhost:3000/form',
    documentRevision: 1
  }
}

test('browser text vault persists only an opaque placeholder while delivering plaintext once', async () => {
  const vault = new BrowserTextVault({ tokenFactory: () => 'token-1' })
  const plaintext = 'PRIVATE_TEXT_SENTINEL\nsecond line'
  const input = {
    action: 'typeText',
    tabId: 'tab-1',
    expectedDocumentRevision: 1,
    text: plaintext
  }
  const revised = { input: vault.redact('call-1', input) as Record<string, unknown> }
  assert.doesNotMatch(JSON.stringify(revised), /PRIVATE_TEXT_SENTINEL|second line/)
  assert.deepEqual(Object.keys(revised.input).sort(), [
    'action',
    'expectedDocumentRevision',
    'tabId',
    'text'
  ])
  const approval = vault.approvalInput('call-1', revised.input)
  assert.doesNotMatch(JSON.stringify(approval), /PRIVATE_TEXT_SENTINEL|second line/)

  const hostCommands: unknown[] = []
  const tool = buildBrowserTool(
    'session-1',
    async (request) => {
      hostCommands.push(request.command)
      return successfulOutcome
    },
    { takeText: (toolCallId, placeholder) => vault.take(toolCallId, placeholder) }
  )
  const result = await tool.execute('call-1', revised.input, undefined, {} as never)
  assert.equal(result.isError, undefined)
  assert.equal((hostCommands[0] as { text?: string }).text, plaintext)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEXT_SENTINEL|second line/)

  const replay = await tool.execute('call-1', revised.input, undefined, {} as never)
  assert.equal(replay.isError, true)
  assert.equal(hostCommands.length, 1)
})

test('browser text vault fail-closes forged placeholders and clears bounded entries', () => {
  const vault = new BrowserTextVault({ cap: 2, tokenFactory: () => 'token-1' })
  const input = (
    text: string
  ): {
    action: string
    tabId: string
    expectedDocumentRevision: number
    text: string
  } => ({
    action: 'typeText',
    tabId: 'tab-1',
    expectedDocumentRevision: 1,
    text
  })
  assert.equal(vault.take('missing', '__phi_browser_text_v1__:token-1'), undefined)
  const first = vault.redact('call-1', input('one'))
  assert.ok(first)
  assert.equal(vault.take('call-1', '__phi_browser_text_v1__:forged'), undefined)
  vault.redact('call-2', input('two'))
  vault.redact('call-3', input('three'))
  assert.equal(vault.take('call-1', first?.text), undefined)
  vault.clear()
  assert.equal(vault.take('call-3', '__phi_browser_text_v1__:token-1'), undefined)
})

test('browser text vault invalidates denied approval without exposing text or reaching the host', async () => {
  const vault = new BrowserTextVault({ tokenFactory: () => 'token-1' })
  const input = {
    action: 'typeText',
    tabId: 'tab-1',
    expectedDocumentRevision: 1,
    text: 'PRIVATE_APPROVAL_SENTINEL'
  }
  const revised = vault.redact('call-1', input)
  const approval = vault.approvalInput('call-1', revised ?? {})
  assert.doesNotMatch(JSON.stringify({ revised, approval }), /PRIVATE_APPROVAL_SENTINEL/)
  vault.markDenied('call-1')
  let hostCalls = 0
  const tool = buildBrowserTool(
    'session-1',
    async () => {
      hostCalls += 1
      return successfulOutcome
    },
    { takeText: (toolCallId, placeholder) => vault.take(toolCallId, placeholder) }
  )
  const result = await tool.execute('call-1', revised ?? {}, undefined, {} as never)
  assert.equal(result.isError, true)
  assert.deepEqual(result.details, { kind: 'browser_error', code: 'PERMISSION_DENIED' })
  assert.equal(hostCalls, 0)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_APPROVAL_SENTINEL/)
})

test('browser pre-dispatch redaction rewrites persistence before a later guard blocks', async () => {
  const vault = new BrowserTextVault({ tokenFactory: () => 'token-1' })
  let guardedContext: unknown
  const session = {
    agent: {
      beforeToolCall: async (context: unknown) => {
        guardedContext = context
        return { block: true, reason: 'plan mode' }
      }
    }
  }
  installBrowserTextPreDispatchRedaction(session, vault)
  const context = {
    toolCall: {
      id: 'call-1',
      name: 'browser',
      arguments: {
        action: 'typeText',
        tabId: 'tab-1',
        expectedDocumentRevision: 1,
        text: 'PRIVATE_PREDISPATCH_SENTINEL'
      }
    },
    args: {
      action: 'typeText',
      tabId: 'tab-1',
      expectedDocumentRevision: 1,
      text: 'PRIVATE_PREDISPATCH_SENTINEL'
    },
    requiredExtraContext: true
  }
  const result = await session.agent.beforeToolCall(context)

  assert.deepEqual(result, { block: true, reason: 'plan mode' })
  assert.doesNotMatch(
    JSON.stringify({
      context,
      guardedContext,
      result,
      approval: vault.approvalInput('call-1', {})
    }),
    /PRIVATE_PREDISPATCH_SENTINEL/
  )
  assert.deepEqual(vault.take('call-1', context.toolCall.arguments.text), { denied: true })
})

test('browser pre-dispatch redaction forces placeholder execution args when guards allow', async () => {
  const vault = new BrowserTextVault({ tokenFactory: () => 'token-1' })
  const session = { agent: { beforeToolCall: async () => undefined } }
  installBrowserTextPreDispatchRedaction(session, vault)
  const context = {
    toolCall: {
      id: 'call-1',
      name: 'browser',
      arguments: {
        action: 'typeText',
        tabId: 'tab-1',
        expectedDocumentRevision: 1,
        text: 'PRIVATE_ALLOWED_SENTINEL'
      }
    },
    args: {
      action: 'typeText',
      tabId: 'tab-1',
      expectedDocumentRevision: 1,
      text: 'PRIVATE_ALLOWED_SENTINEL'
    }
  }
  const result = (await session.agent.beforeToolCall(context)) as {
    args?: Record<string, unknown>
  }
  assert.equal(result.args?.text, '__phi_browser_text_v1__:token-1')
  assert.doesNotMatch(JSON.stringify({ context, result }), /PRIVATE_ALLOWED_SENTINEL/)
})

test('browser pre-dispatch redaction removes malformed raw JSON before persistence', async () => {
  const vault = new BrowserTextVault({ tokenFactory: () => 'token-1' })
  const session = { agent: { beforeToolCall: async () => undefined } }
  installBrowserTextPreDispatchRedaction(session, vault)
  const context = {
    toolCall: {
      id: 'call-parse-error',
      name: 'browser',
      arguments: {
        __parseError: 'invalid JSON',
        __rawJson: '{"action":"typeText","text":"PRIVATE_RAW_JSON_SENTINEL"'
      }
    },
    args: {}
  }
  const result = (await session.agent.beforeToolCall(context)) as {
    args?: Record<string, unknown>
  }
  assert.deepEqual(context.toolCall.arguments, { action: 'invalid' })
  assert.deepEqual(result.args, { action: 'invalid' })
  assert.doesNotMatch(JSON.stringify({ context, result }), /PRIVATE_RAW_JSON_SENTINEL|rawJson/)
})

test('browser pre-dispatch redaction removes forbidden selector and script fields', async () => {
  const vault = new BrowserTextVault({ tokenFactory: () => 'token-1' })
  const session = { agent: { beforeToolCall: async () => undefined } }
  installBrowserTextPreDispatchRedaction(session, vault)
  for (const [index, args] of [
    { action: 'click', selector: '#PRIVATE_SELECTOR_SENTINEL' },
    { action: 'open', javascript: 'PRIVATE_SCRIPT_SENTINEL()' },
    { action: 'open', url: 'https://example.test', extra: 'EXTRA_SENTINEL' },
    { action: 'open', text: 'PRIVATE_WRONG_ACTION_SENTINEL' },
    { action: 'snapshot', descriptor: { accessibleLabel: 'PRIVATE_LABEL_SENTINEL' } }
  ].entries()) {
    const context = {
      toolCall: { id: `call-${index}`, name: 'browser', arguments: args },
      args
    }
    const result = (await session.agent.beforeToolCall(context)) as {
      args?: Record<string, unknown>
    }
    assert.deepEqual(context.toolCall.arguments, { action: 'invalid' })
    assert.deepEqual(result.args, { action: 'invalid' })
    assert.doesNotMatch(
      JSON.stringify({ context, result }),
      /PRIVATE_SELECTOR_SENTINEL|PRIVATE_SCRIPT_SENTINEL|PRIVATE_LABEL_SENTINEL|PRIVATE_WRONG_ACTION_SENTINEL|EXTRA_SENTINEL/
    )
    assert.deepEqual(vault.approvalInput(context.toolCall.id, args), { action: 'invalid' })
  }
})

test('browser pre-dispatch sanitizer preserves only exact supported action shapes', () => {
  const vault = new BrowserTextVault({ tokenFactory: () => 'token-1' })
  const ordinary = [
    { action: 'open', url: 'https://example.test' },
    { action: 'snapshot', tabId: 'tab-1' },
    {
      action: 'click',
      tabId: 'tab-1',
      expectedDocumentRevision: 1,
      x: 2,
      y: 3,
      consequence: 'read'
    },
    {
      action: 'scroll',
      tabId: 'tab-1',
      expectedDocumentRevision: 1,
      deltaX: 0,
      deltaY: 120
    },
    {
      action: 'keypress',
      tabId: 'tab-1',
      expectedDocumentRevision: 1,
      key: 'Tab',
      modifiers: ['shift']
    }
  ]
  ordinary.forEach((input, index) => {
    assert.deepEqual(vault.sanitize(`call-${index}`, input), input)
  })
  const typeText = vault.sanitize('call-type', {
    action: 'typeText',
    target: 'current',
    tabId: 'tab-1',
    expectedDocumentRevision: 1,
    text: 'PRIVATE_EXACT_SENTINEL'
  })
  assert.deepEqual(typeText, {
    action: 'typeText',
    target: 'current',
    tabId: 'tab-1',
    expectedDocumentRevision: 1,
    text: '__phi_browser_text_v1__:token-1'
  })
  assert.doesNotMatch(JSON.stringify(typeText), /PRIVATE_EXACT_SENTINEL/)
})

test('browser text vault strips invalid extra fields and never releases their plaintext', async () => {
  const vault = new BrowserTextVault({ tokenFactory: () => 'token-1' })
  const revised = vault.redact('call-1', {
    action: 'typeText',
    tabId: 'tab-1',
    expectedDocumentRevision: 1,
    text: 'PRIVATE_SELECTOR_SENTINEL',
    selector: '#password',
    javascript: 'steal()'
  })
  assert.doesNotMatch(JSON.stringify(revised), /PRIVATE_SELECTOR_SENTINEL|password|steal/)
  assert.equal(vault.take('call-1', revised?.text), undefined)

  let hostCalls = 0
  const tool = buildBrowserTool(
    'session-1',
    async () => {
      hostCalls += 1
      return successfulOutcome
    },
    { takeText: (toolCallId, placeholder) => vault.take(toolCallId, placeholder) }
  )
  const result = await tool.execute('call-1', revised ?? {}, undefined, {} as never)
  assert.equal(result.isError, true)
  assert.equal(hostCalls, 0)
})

test('browser text vault redacts a text field even when the model supplied the wrong action', () => {
  const vault = new BrowserTextVault({ tokenFactory: () => 'token-1' })
  const revised = vault.redact('call-wrong-action', {
    action: 'open',
    url: 'http://localhost:3000/',
    text: 'PRIVATE_WRONG_ACTION_SENTINEL'
  })
  assert.deepEqual(revised, { action: 'invalid' })
  assert.doesNotMatch(JSON.stringify(revised), /PRIVATE_WRONG_ACTION_SENTINEL/)
  assert.equal(vault.take('call-wrong-action', revised?.text), undefined)
})

test('browser pre-dispatch abort revokes plaintext before execution can consume it', async () => {
  const vault = new BrowserTextVault({ tokenFactory: () => 'token-1' })
  const session = { agent: { beforeToolCall: async () => undefined } }
  installBrowserTextPreDispatchRedaction(session, vault)
  const controller = new AbortController()
  const context = {
    toolCall: {
      id: 'call-abort',
      name: 'browser',
      arguments: {
        action: 'typeText',
        tabId: 'tab-1',
        expectedDocumentRevision: 1,
        text: 'PRIVATE_ABORT_SENTINEL'
      }
    },
    args: {
      action: 'typeText',
      tabId: 'tab-1',
      expectedDocumentRevision: 1,
      text: 'PRIVATE_ABORT_SENTINEL'
    }
  }
  await session.agent.beforeToolCall(context, controller.signal)
  controller.abort()
  assert.deepEqual(vault.take('call-abort', context.toolCall.arguments.text), { denied: true })
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE_ABORT_SENTINEL/)
})

test('browser prompt cleanup clears plaintext after success and failure', async () => {
  for (const fail of [false, true]) {
    const vault = new BrowserTextVault({ tokenFactory: () => 'token-1' })
    const revised = vault.sanitize('call-cleanup', {
      action: 'typeText',
      tabId: 'tab-1',
      expectedDocumentRevision: 1,
      text: 'PRIVATE_CLEANUP_SENTINEL'
    })
    if (fail) {
      await assert.rejects(
        withBrowserTextVaultCleanup(vault, async () => {
          throw new Error('prompt failed')
        }),
        /prompt failed/
      )
    } else {
      assert.equal(await withBrowserTextVaultCleanup(vault, async () => 'complete'), 'complete')
    }
    assert.equal(vault.take('call-cleanup', revised.text), undefined)
  }
})

test('browser text vault removes abort listeners after take and clear', () => {
  class FakeSignal {
    aborted = false
    readonly listeners = new Set<() => void>()
    addEventListener(_type: string, listener: () => void): void {
      this.listeners.add(listener)
    }
    removeEventListener(_type: string, listener: () => void): void {
      this.listeners.delete(listener)
    }
    abort(): void {
      this.aborted = true
      for (const listener of [...this.listeners]) listener()
    }
  }
  const input = {
    action: 'typeText',
    tabId: 'tab-1',
    expectedDocumentRevision: 1,
    text: 'private'
  }
  const vault = new BrowserTextVault({ tokenFactory: () => 'token-1' })
  const first = vault.sanitize('call-1', input)
  const firstSignal = new FakeSignal()
  vault.watchAbort('call-1', firstSignal as unknown as AbortSignal)
  assert.equal(firstSignal.listeners.size, 1)
  assert.deepEqual(vault.take('call-1', first.text), { text: 'private' })
  assert.equal(firstSignal.listeners.size, 0)
  firstSignal.abort()

  vault.sanitize('call-2', input)
  const secondSignal = new FakeSignal()
  vault.watchAbort('call-2', secondSignal as unknown as AbortSignal)
  assert.equal(secondSignal.listeners.size, 1)
  vault.clear()
  assert.equal(secondSignal.listeners.size, 0)
  secondSignal.abort()
})
