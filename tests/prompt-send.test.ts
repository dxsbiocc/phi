import assert from 'node:assert/strict'
import test from 'node:test'

import { sendPrompt, type PromptSendDeps } from '../src/renderer/src/features/chat/lib/promptSend'
import { sessionDraftKey } from '../src/renderer/src/lib/sessionDrafts'
import type {
  ChatItem,
  ModelOption,
  PromptResult,
  ProviderAuthStatus
} from '../src/renderer/src/types'

const model: ModelOption = {
  providerId: 'provider',
  modelId: 'model',
  name: 'Model',
  thinkingLevels: []
}
const provider: ProviderAuthStatus = {
  providerId: 'provider',
  name: 'Provider',
  configured: true,
  hasApiKey: true,
  hasOAuth: false,
  hasConfigError: false,
  statusText: ''
}
const target = {
  path: '/a.jsonl',
  phiSessionId: 'phi-a',
  cwd: '/project',
  sessionGeneration: 3
}

type Harness = {
  deps: PromptSendDeps
  events: string[]
  messages: () => ChatItem[]
  drafts: () => Record<string, string>
  draftImages: () => Record<string, unknown>
  sent: Array<{ text: string; target: unknown }>
  settingsOpened: () => number
  applyReceipt: (receipt: Partial<PromptResult> | null) => void
  failWith: (error: Error) => void
  bumpSendRequest: () => void
}

function harness(
  options: {
    selectedModel?: ModelOption | null
    supportsImages?: boolean
    modelStateReady?: boolean
    configured?: boolean
    availableModels?: ModelOption[]
    activeSessionPath?: string | null
    activeDraftKey?: string
    generation?: number
    activePhiSessionId?: string | null
  } = {}
): Harness {
  const events: string[] = []
  const sent: Array<{ text: string; target: unknown }> = []
  let messages: ChatItem[] = []
  let drafts: Record<string, string> = {}
  let draftImages: Record<string, unknown> = {}
  let closedKeys = new Set(['session:phi-a:3'])
  let tabKey: string | null = null
  let selectedModel: ModelOption | null =
    options.selectedModel === undefined ? model : options.selectedModel
  let settings = 0
  let pending: {
    resolve: (value: PromptResult | null) => void
    reject: (error: Error) => void
  } | null = null

  const deps: PromptSendDeps = {
    rendererApi: {
      sendPrompt: (text, sendTarget) => {
        sent.push({ text, target: sendTarget })
        return new Promise((resolve, reject) => {
          pending = { resolve, reject }
        })
      },
      getSelectedModel: async () => ({
        providerId: 'provider',
        modelId: 'model',
        thinkingLevel: 'off'
      })
    },
    readiness: {
      modelStateReady: options.modelStateReady ?? true,
      providers: options.configured === false ? [{ ...provider, configured: false }] : [provider],
      availableModels: options.availableModels ?? [model],
      models: [model],
      selectedModel,
      openSettings: () => {
        settings += 1
        events.push('openSettings')
      }
    },
    actions: {
      updateMessages: (updater) => {
        messages = updater(messages)
        events.push('updateMessages')
      },
      setIsSendingMessage: (value) => events.push(`sending:${value}`),
      setDraftImagesBySession: (updater) => {
        draftImages = updater(
          draftImages as unknown as Parameters<typeof updater>[0] extends (
            previous: infer T
          ) => unknown
            ? T
            : never
        )
        events.push('restoreImages')
      },
      setDraftInputs: (updater) => {
        drafts = updater(drafts)
        events.push('restoreDraft')
      },
      setActiveSessionPath: (path) => events.push(`activePath:${path}`),
      setActivePhiSessionId: (id) => events.push(`activePhi:${id}`),
      setClosedWorkspaceSessionTabKeys: (updater) => {
        closedKeys = updater(closedKeys)
        events.push('closedTabs')
      },
      setActiveWorkspaceTabKey: (updater) => {
        tabKey = updater(tabKey)
        events.push(`tabKey:${tabKey}`)
      },
      setSelectedModel: (updater) => {
        selectedModel = updater(selectedModel)
        events.push('selectedModel')
      },
      moveQueuedPromptsToSession: (key) => events.push(`move:${key}`),
      refreshSessions: () => {
        events.push('refreshSessions')
      },
      showSnackbarError: () => events.push('error')
    },
    activeDraftKey: options.activeDraftKey ?? 'draft-a',
    activeSessionPath: options.activeSessionPath ?? '/a.jsonl',
    isSendingRef: { current: false },
    sendRequestRef: { current: 0 },
    getSession: () => ({
      activeSessionGeneration: options.generation ?? 3,
      activePhiSessionId: options.activePhiSessionId ?? 'phi-a'
    })
  }

  return {
    deps,
    events,
    messages: () => messages,
    drafts: () => drafts,
    draftImages: () => draftImages,
    sent,
    settingsOpened: () => settings,
    applyReceipt: (receipt) =>
      pending?.resolve(
        receipt === null
          ? null
          : ({
              ok: true,
              path: '/a.jsonl',
              phiSessionId: 'phi-a',
              sessionGeneration: 3,
              ...receipt
            } as PromptResult)
      ),
    failWith: (error) => pending?.reject(error),
    bumpSendRequest: () => {
      deps.sendRequestRef.current += 1
    }
  }
}

test('a blank prompt with no images never dispatches', async () => {
  const h = harness()
  assert.equal(await sendPrompt(h.deps, '   ', target), false)
  assert.equal(h.sent.length, 0)
  assert.deepEqual(h.events, [])
})

test('a prompt is refused while another send is in flight', async () => {
  const h = harness()
  h.deps.isSendingRef.current = true
  assert.equal(await sendPrompt(h.deps, 'hello', target), false)
  assert.equal(h.sent.length, 0)
})

test('unsupported images and provider readiness block the send before dispatch', async () => {
  const images = harness({ selectedModel: { ...model, supportsImages: false } })
  assert.equal(
    await sendPrompt(images.deps, 'hello', target, {
      images: [{ dataUrl: 'data:', name: 'a' } as never]
    }),
    false
  )
  assert.ok(images.events.includes('error'))
  assert.equal(images.sent.length, 0)

  const notReady = harness({ configured: false })
  assert.equal(await sendPrompt(notReady.deps, 'hello', target), false)
  assert.equal(notReady.settingsOpened(), 1)

  const loading = harness({ modelStateReady: false })
  assert.equal(await sendPrompt(loading.deps, 'hello', target), false)
  assert.equal(loading.settingsOpened(), 0)
})

test('a dispatch records the user message optimistically and settles to idle', async () => {
  const h = harness()
  const sending = sendPrompt(h.deps, 'hello', target)
  assert.equal(h.sent.length, 1)
  const [message] = h.messages()
  assert.ok(message?.role === 'user')
  assert.deepEqual([message.content], ['hello'])
  assert.ok(h.events.includes('sending:true'))

  h.applyReceipt({})
  assert.equal(await sending, true)
  assert.ok(h.events.includes('sending:false'))
  assert.equal(h.deps.isSendingRef.current, false)
  assert.ok(h.events.includes('refreshSessions'))
})

test('a fresh session receipt moves the queue and selects the materialized tab', async () => {
  const h = harness({
    activeSessionPath: null,
    activePhiSessionId: null,
    activeDraftKey: 'draft-fresh',
    generation: 4
  })
  const sending = sendPrompt(h.deps, 'first', {
    ...target,
    path: null,
    phiSessionId: undefined,
    sessionGeneration: 4
  })
  h.applyReceipt({
    path: '/new.jsonl',
    phiSessionId: 'phi-new',
    sessionGeneration: 4
  })
  assert.equal(await sending, true)
  const materializedKey = sessionDraftKey({
    phiSessionId: 'phi-new',
    path: '/new.jsonl',
    cwd: '/project',
    sessionGeneration: 4
  })
  assert.ok(h.events.includes(`move:${materializedKey}`))
  assert.ok(h.events.includes('activePath:/new.jsonl'))
  assert.ok(h.events.includes('activePhi:phi-new'))
  assert.ok(h.events.includes('tabKey:session:/new.jsonl'))
})

test('a reply from a superseded request or generation applies no receipt', async () => {
  const superseded = harness()
  const sending = sendPrompt(superseded.deps, 'hello', target)
  superseded.bumpSendRequest()
  superseded.applyReceipt({})
  assert.equal(await sending, true)
  assert.ok(!superseded.events.some((event) => event.startsWith('activePath:')))
  assert.equal(superseded.deps.isSendingRef.current, true)

  const wrongGeneration = harness()
  const waiting = sendPrompt(wrongGeneration.deps, 'hello', target)
  wrongGeneration.applyReceipt({ sessionGeneration: 7 })
  assert.equal(await waiting, true)
  assert.ok(!wrongGeneration.events.some((event) => event.startsWith('activePath:')))
})

test('a current failure reports the error and gives the draft and images back', async () => {
  const h = harness()
  const sending = sendPrompt(h.deps, 'draft text', target, {
    images: [{ dataUrl: 'data:', name: 'a' } as never]
  })
  h.failWith(new Error('boom'))
  assert.equal(await sending, true)
  assert.ok(h.events.includes('error'))
  assert.equal(h.drafts()['draft-a'], 'draft text')
  assert.deepEqual(h.draftImages()['draft-a'], [{ dataUrl: 'data:', name: 'a' }])
  assert.ok(h.events.includes('sending:false'))
})

test('a failure from a superseded request stays silent and keeps the newer send live', async () => {
  const h = harness()
  const sending = sendPrompt(h.deps, 'hello', target)
  h.bumpSendRequest()
  h.failWith(new Error('late'))
  assert.equal(await sending, true)
  assert.ok(!h.events.includes('error'))
  assert.equal(h.events.includes('restoreDraft'), false)
  assert.equal(h.deps.isSendingRef.current, true)
})

test('retry and suppressed-user-message sends keep their shapes', async () => {
  const retry = harness()
  const retrying = sendPrompt(retry.deps, 'again', target, { retryUserMessageId: 'user-1' })
  assert.equal(retry.messages().length, 0)
  retry.applyReceipt({})
  await retrying

  const suppressed = harness()
  const sending = sendPrompt(suppressed.deps, 'again', target, {
    suppressUserMessageEvent: true,
    planMode: true,
    appendUserMessage: false
  })
  assert.deepEqual(suppressed.messages(), [])
  assert.deepEqual(suppressed.sent[0].target, {
    ...target,
    planMode: true,
    suppressUserMessageEvent: true
  })
  suppressed.applyReceipt({})
  await sending
})

test('a refused send leaves the in-flight flag and request token untouched', async () => {
  const h = harness({ configured: false })
  await sendPrompt(h.deps, 'hello', target)
  assert.equal(h.deps.isSendingRef.current, false)
  assert.equal(h.deps.sendRequestRef.current, 0)
})
