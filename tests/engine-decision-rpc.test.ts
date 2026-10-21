import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserTextVault } from '../src/main/agent/browser/browser-text-vault'
import { HostServiceRegistry } from '../src/main/agent/engine/host-service-registry'
import {
  createRpcDesktopToolScope,
  type RpcDesktopToolRun
} from '../src/main/agent/engine/rpc/desktop-tool-scope'
import { bindSessionDecisionEvaluator } from '../src/main/agent/engine/decision-evaluator'
import { appRpcDesktopToolNames } from '../src/main/agent/remote-session-routing'
import type { DecisionResult } from '../src/shared/decisionTypes'

const request = {
  purpose: 'recovery',
  context: 'No output after an interrupted transport.',
  question: 'How should the caller proceed?',
  options: [
    { id: 'inspect', description: 'Inspect before retry' },
    { id: 'retry', description: 'Repeat the idempotent read' }
  ]
}
const answer: DecisionResult = {
  choice: 'inspect',
  source: 'model',
  model: { providerId: 'chat', modelId: 'actual' }
}
const identity = {
  runtimeSessionId: 'runtime-session',
  sessionId: 'phi-session',
  projectId: 'project',
  cwd: '/server/project'
}
const context = { cwd: identity.cwd, recentUserImages: () => [] }

test('RPC main decision uses its current trusted model, read policy and existing stale-run fence', async (t) => {
  const controller = new AbortController()
  let run: RpcDesktopToolRun | undefined = { id: 'main-run', signal: controller.signal }
  let current = { provider: 'chat', id: 'actual' }
  let finish!: (value: DecisionResult) => void
  let captured: unknown
  let upstream: AbortSignal | undefined
  const decide = bindSessionDecisionEvaluator({
    agentDir: '/desktop/profile',
    sessionId: identity.runtimeSessionId,
    currentModel: () => current,
    evaluate: async (input, signal) => {
      captured = input
      upstream = signal
      return new Promise((resolve) => {
        finish = resolve
      })
    }
  })
  const options = {
    identity,
    services: new HostServiceRegistry(),
    currentRun: () => run,
    recentUserImages: () => [],
    allowBrowserTypeText: () => false,
    browserTextVault: new BrowserTextVault(),
    agentDir: '/desktop/profile',
    allowedSkills: [],
    scriptTools: [],
    decide
  }
  const scope = createRpcDesktopToolScope(options)
  const child = createRpcDesktopToolScope({
    ...options,
    toolOwner: 'Research',
    ownsSharedResources: false
  })
  t.after(() => {
    child.dispose()
    scope.dispose()
  })
  assert.ok(appRpcDesktopToolNames().includes('phi_decide'))
  assert.equal(scope.approvalFor('phi_decide', {}), 'read')
  assert.equal(
    child.tools.some((tool) => tool.name === 'phi_decide'),
    false
  )
  const tool = scope.tools.find((tool) => tool.name === 'phi_decide')!
  const pending = tool.execute('decision-call', request, undefined, context)
  assert.deepEqual(captured, {
    agentDir: '/desktop/profile',
    sessionId: 'runtime-session',
    model: answer.model,
    request
  })
  current = { provider: 'chat', id: 'next' }
  run = { id: 'successor', signal: new AbortController().signal }
  finish(answer)
  await assert.rejects(pending, /binding changed/)
  const next = tool.execute('next-call', request, undefined, context)
  const failure = assert.rejects(next, /scope disposed/)
  scope.dispose()
  assert.equal(upstream?.aborted, true)
  await failure
  finish(answer)
})

test('RPC decision rejects an unstable run identity before provider dispatch', async (t) => {
  const controller = new AbortController()
  let upstream: AbortSignal | undefined
  let calls = 0
  const scope = createRpcDesktopToolScope({
    identity,
    services: new HostServiceRegistry(),
    currentRun: () => ({ id: 'main-run', signal: controller.signal }),
    recentUserImages: () => [],
    allowBrowserTypeText: () => false,
    browserTextVault: new BrowserTextVault(),
    agentDir: '/desktop/profile',
    allowedSkills: [],
    scriptTools: [],
    decide: async (_request, signal) => {
      calls++
      upstream = signal
      return new Promise(() => {})
    }
  })
  t.after(() => scope.dispose())
  // Identity is intentionally unstable above: the scope must reject before provider dispatch.
  const tool = scope.tools.find((tool) => tool.name === 'phi_decide')!
  await assert.rejects(tool.execute('call', request, undefined, context), /binding changed/)
  assert.equal(calls, 0)
  assert.equal(upstream, undefined)
})

test('RPC stop physically aborts the inflight evaluator and ignores its late reply across runs', async (t) => {
  const controller = new AbortController()
  const successor = new AbortController()
  let run: RpcDesktopToolRun = { id: 'original-run', signal: controller.signal }
  const signals: AbortSignal[] = []
  const completions: Array<(value: DecisionResult) => void> = []
  const scope = createRpcDesktopToolScope({
    identity,
    services: new HostServiceRegistry(),
    currentRun: () => run,
    recentUserImages: () => [],
    allowBrowserTypeText: () => false,
    browserTextVault: new BrowserTextVault(),
    agentDir: '/desktop/profile',
    allowedSkills: [],
    scriptTools: [],
    decide: async (_request, signal) => {
      signals.push(signal!)
      return new Promise((resolve) => completions.push(resolve))
    }
  })
  t.after(() => scope.dispose())
  const tool = scope.tools.find((tool) => tool.name === 'phi_decide')!
  const pending = tool.execute('old-call', request, undefined, context)
  const rejected = assert.rejects(pending, /stop original/)
  controller.abort(new Error('stop original'))
  await rejected
  assert.equal(signals[0].aborted, true)
  run = { id: 'successor-run', signal: successor.signal }
  const next = tool.execute('new-call', request, undefined, context)
  completions[0]({ ...answer, choice: 'retry' })
  assert.equal(signals[1].aborted, false)
  completions[1](answer)
  assert.deepEqual((await next).details, answer)
  assert.equal(successor.signal.aborted, false)
})
