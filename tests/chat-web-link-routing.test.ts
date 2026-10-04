import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import type { BrowserOutcome, BrowserWorkspaceSnapshot } from '../src/shared/browserTypes'
import { createBrowserLinkOpeningCoordinator } from '../src/renderer/src/features/browser/lib/browserLinkOpening'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function snapshot(sessionId: string): BrowserWorkspaceSnapshot {
  return {
    sessionId,
    activeTabId: 'tab-1',
    tabs: [],
    capabilities: {
      presentation: 'native',
      screenshot: false,
      coordinateInput: false,
      semanticInspection: false,
      downloads: false,
      recording: false,
      persistentProfile: false
    },
    revision: 1
  }
}

function successfulOutcome(sessionId: string): BrowserOutcome {
  return { ok: true, snapshot: snapshot(sessionId) }
}

function failedOutcome(sessionId: string): BrowserOutcome {
  return {
    ok: false,
    error: { code: 'NAVIGATION_FAILED', message: 'failed', retryable: true },
    snapshot: snapshot(sessionId)
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
} {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason: unknown) => void
  return {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    }),
    resolve: resolvePromise,
    reject: rejectPromise
  }
}

test('web link opener stays a narrow callback through every chat rendering layer', () => {
  const bubble = source('src/renderer/src/components/chat/ChatBubble.tsx')
  const processingGroup = source('src/renderer/src/components/chat/ChatProcessingGroup.tsx')
  const messageList = source('src/renderer/src/components/chat/ChatMessageList.tsx')
  const chatView = source('src/renderer/src/features/chat/ChatView.tsx')

  assert.match(bubble, /<MarkdownContent[\s\S]*?onOpenWebUrl=\{onOpenWebUrl\}/)
  assert.ok(
    (processingGroup.match(/onOpenWebUrl=\{onOpenWebUrl\}/g) ?? []).length >= 2,
    'processing groups must thread web links through recursion and assistant bubbles'
  )
  assert.ok(
    (messageList.match(/onOpenWebUrl=\{onOpenWebUrl\}/g) ?? []).length >= 2,
    'message list must thread web links through processing and ordinary groups'
  )
  assert.match(chatView, /<ChatMessageList[\s\S]*?onOpenWebUrl=\{onOpenWebUrl\}/)
})

test('link-opening coordinator opens the panel only after a matching-session success', async () => {
  const pending = deferred<BrowserOutcome>()
  const commands: Array<{ type: 'open'; requestId: string; url: string }> = []
  const activeSessionId: string | null = 'session-a'
  let opened = 0
  let failures = 0
  const coordinator = createBrowserLinkOpeningCoordinator({
    execute: (command) => {
      commands.push(command)
      return pending.promise
    },
    nextRequestId: () => 'request-1',
    getActiveSessionId: () => activeSessionId,
    openBrowserPanel: () => {
      opened += 1
    },
    showFailure: () => {
      failures += 1
    }
  })

  const opening = coordinator.open('https://example.com/docs')
  assert.equal(opened, 0)
  assert.deepEqual(commands, [
    { type: 'open', requestId: 'request-1', url: 'https://example.com/docs' }
  ])
  pending.resolve(successfulOutcome('session-a'))
  await opening

  assert.equal(activeSessionId, 'session-a')
  assert.equal(opened, 1)
  assert.equal(failures, 0)
})

test('link-opening coordinator reports current failures without opening the panel', async () => {
  let behavior: 'outcome' | 'throw' = 'outcome'
  let failures = 0
  let opened = 0
  const coordinator = createBrowserLinkOpeningCoordinator({
    execute: async () => {
      if (behavior === 'throw') throw new Error('ipc failed')
      return failedOutcome('session-a')
    },
    nextRequestId: () => 'request-failure',
    getActiveSessionId: () => 'session-a',
    openBrowserPanel: () => {
      opened += 1
    },
    showFailure: () => {
      failures += 1
    }
  })

  await coordinator.open('https://example.com/fails')
  behavior = 'throw'
  await coordinator.open('https://example.com/throws')

  assert.equal(opened, 0)
  assert.equal(failures, 2)
})

test('link-opening coordinator ignores stale, invalidated, and switched-session completions', async () => {
  const pending: Array<ReturnType<typeof deferred<BrowserOutcome>>> = []
  let activeSessionId: string | null = 'session-a'
  let opened = 0
  let failures = 0
  const coordinator = createBrowserLinkOpeningCoordinator({
    execute: async () => {
      const request = deferred<BrowserOutcome>()
      pending.push(request)
      return request.promise
    },
    nextRequestId: () => `request-${pending.length + 1}`,
    getActiveSessionId: () => activeSessionId,
    openBrowserPanel: () => {
      opened += 1
    },
    showFailure: () => {
      failures += 1
    }
  })

  const first = coordinator.open('https://example.com/first')
  const second = coordinator.open('https://example.com/second')
  pending[1].resolve(successfulOutcome('session-a'))
  await second
  pending[0].resolve(successfulOutcome('session-a'))
  await first
  assert.equal(opened, 1)

  const invalidated = coordinator.open('https://example.com/invalidated')
  coordinator.invalidate()
  pending[2].resolve(successfulOutcome('session-a'))
  await invalidated

  const switched = coordinator.open('https://example.com/switched')
  activeSessionId = 'session-b'
  pending[3].resolve(successfulOutcome('session-a'))
  await switched

  assert.equal(opened, 1)
  assert.equal(failures, 0)
})

test('link-opening coordinator rejects a success snapshot from another session', async () => {
  let opened = 0
  let failures = 0
  const coordinator = createBrowserLinkOpeningCoordinator({
    execute: async () => successfulOutcome('session-b'),
    nextRequestId: () => 'request-mismatch',
    getActiveSessionId: () => 'session-a',
    openBrowserPanel: () => {
      opened += 1
    },
    showFailure: () => {
      failures += 1
    }
  })

  await coordinator.open('https://example.com/mismatch')

  assert.equal(opened, 0)
  assert.equal(failures, 1)
})

test('App composes link opening and invalidates it on explicit panel actions', () => {
  const app = source('src/renderer/src/App.tsx')
  const trustedOverlayEnqueue = app.match(
    /const enqueueBrowserTrustedOverlay = useCallback\([\s\S]*?\n {2}const openLocalTrustedOverlay/
  )?.[0]

  assert.match(
    app,
    /createBrowserLinkOpeningCoordinator\(\{[\s\S]*?execute: \(command\) => rendererApi\.browser\.execute\(command\)[\s\S]*?getActiveSessionId:[\s\S]*?openBrowserPanel: \(\) => \{[\s\S]*?setTerminalPanelMaximized\(false\)[\s\S]*?setWorkspaceSidePanelMode\('browser'\)[\s\S]*?showFailure:/
  )
  assert.match(app, /onOpenWebUrl[\s\S]*?browserLinkOpeningCoordinator\.open\(url\)/)
  assert.ok(trustedOverlayEnqueue, 'trusted overlay enqueue must have one App-level wrapper')
  assert.ok(
    trustedOverlayEnqueue.indexOf('browserLinkOpeningCoordinator.invalidate()') <
      trustedOverlayEnqueue.indexOf('enqueueBrowserTrustedOverlayGate(request)'),
    'pending link opens must be invalidated synchronously before the gate starts work'
  )
  assert.match(
    app,
    /const openLocalTrustedOverlay = useCallback\([\s\S]*?enqueueBrowserTrustedOverlay\(\{[\s\S]*?kind: 'local'/
  )
  assert.match(
    app,
    /rendererApi\.onAuthInteraction\([\s\S]*?enqueueBrowserTrustedOverlay\(\{[\s\S]*?kind: 'auth'/
  )
  assert.match(
    app,
    /rendererApi\.onToolApprovalRequest\([\s\S]*?enqueueBrowserTrustedOverlay\(\{[\s\S]*?kind: 'approval'/
  )
  assert.match(
    app,
    /rendererApi\.onAgentUserInteractionRequest\([\s\S]*?enqueueBrowserTrustedOverlay\(\{[\s\S]*?kind: 'interaction'/
  )
  assert.match(app, /<ChatView[\s\S]*?onOpenWebUrl=\{onOpenWebUrl\}/)
})
