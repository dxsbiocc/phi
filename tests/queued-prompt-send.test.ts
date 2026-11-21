import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { appCopy } from '../src/renderer/src/lib/appCopy'
import type { SendPromptOptions } from '../src/renderer/src/features/chat/lib/promptQueue'

function appCallback<T>(name: string, context: Record<string, unknown>): T {
  const path = 'src/renderer/src/App.tsx'
  const syntax = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let initializer: ts.Expression | undefined
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
      initializer = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.ok(initializer)
  const code = ts.transpileModule(`(${initializer.getText(syntax)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return runInNewContext(code, {
    useCallback: (callback: unknown) => callback,
    appCopy,
    ...context
  }) as T
}

function harness(sendResult: boolean): {
  send: (id: string) => Promise<void>
  stopped: () => number
  sentOptions: () => SendPromptOptions | undefined
  queuedIds: () => string[]
} {
  const target = {
    phiSessionId: 'phi-1',
    path: '/session.jsonl',
    cwd: '/workspace',
    sessionGeneration: 3
  }
  const prompts = [
    { id: 'queued-1', text: 'first', target },
    { id: 'queued-2', text: 'inserted', target },
    { id: 'queued-3', text: 'last', target }
  ]
  let queue = [...prompts]
  let stopped = 0
  let sentOptions: SendPromptOptions | undefined
  const activeQueuedPromptsRef = { current: queue }
  const removeQueuedPrompt = (id: string): void => {
    queue = queue.filter((item) => item.id !== id)
    activeQueuedPromptsRef.current = queue
  }
  const send = appCallback<(id: string) => Promise<void>>('onSendQueuedPrompt', {
    queuedPromptSendRef: { current: null },
    isSessionChanging: false,
    isCompactingKey: () => false,
    activeContextCompactionKey: 'phi-1',
    activeQueuedPrompts: queue,
    activeQueuedPromptsRef,
    currentSessionIsBusyRef: { current: true },
    isSendingRef: { current: true },
    onStopGeneration: async () => {
      stopped += 1
    },
    useSessionStore: {
      getState: () => ({
        activePhiSessionId: target.phiSessionId,
        activeSessionPath: target.path,
        activeCwd: target.cwd,
        activeSessionGeneration: target.sessionGeneration
      })
    },
    sessionDraftKey: () => 'draft-1',
    activeDraftKey: 'draft-1',
    sendPromptText: async (
      _text: string,
      _target: unknown,
      options: SendPromptOptions & { onSendStarted: () => void }
    ) => {
      sentOptions = options
      options.onSendStarted()
      return sendResult
    },
    removeQueuedPrompt,
    restoreQueuedPrompt: (prompt: (typeof prompts)[number], index: number) => {
      if (!queue.some((item) => item.id === prompt.id)) {
        queue = [...queue.slice(0, index), prompt, ...queue.slice(index)]
        activeQueuedPromptsRef.current = queue
      }
    },
    showSnackbarError: () => undefined
  })
  return {
    send,
    stopped: () => stopped,
    sentOptions: () => sentOptions,
    queuedIds: () => queue.map((item) => item.id)
  }
}

test('inserting a queued prompt follows up the current run without stopping it', async () => {
  const app = harness(true)

  await app.send('queued-2')

  assert.equal(app.stopped(), 0)
  assert.equal(app.sentOptions()?.followUp, true)
  assert.deepEqual(app.queuedIds(), ['queued-1', 'queued-3'])
})

test('a rejected follow-up returns the selected prompt at its original queue position', async () => {
  const app = harness(false)

  await app.send('queued-2')

  assert.equal(app.stopped(), 0)
  assert.equal(app.sentOptions()?.followUp, true)
  assert.deepEqual(app.queuedIds(), ['queued-1', 'queued-2', 'queued-3'])
})
