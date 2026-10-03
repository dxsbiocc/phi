import assert from 'node:assert/strict'
import test from 'node:test'

import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import { buildAgentLeaderPrompt } from '../src/main/agent/agents/leader-prompt'
import {
  AgentRunLimitError,
  AgentRunRegistry,
  type AgentRunSnapshot
} from '../src/main/agent/agents/registry'
import {
  AgentCancelledError,
  AgentTimeoutError,
  createAgentRunner,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentSessionLike
} from '../src/main/agent/agents/runner'
import { controlAgentRun } from '../src/main/agent/agents/run-control'
import { buildAgentRunTools } from '../src/main/agent/agents/run-tools'
import { buildAgentTool, type AgentRunner } from '../src/main/agent/agents/tool'
import type { PhiAgentDefinition } from '../src/main/agent/agents/definition'

const WRAPPER: PhiAgentDefinition = {
  name: 'Wrapper',
  description: 'Runs and creates Nextflow wrappers.',
  tools: ['read'],
  skills: [],
  systemPrompt: 'You are Wrapper.',
  source: 'phi',
  filePath: '/agents/Wrapper.md',
  visibility: 'entry',
  warnings: []
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A runner the test finishes by hand; honours the abort signal like the real one. */
function controlledRunner(): {
  runner: AgentRunner
  started: AgentRunRequest[]
  finish: (index: number, text?: string) => void
  steered: string[]
} {
  const gates: Array<Deferred<AgentRunResult>> = []
  const started: AgentRunRequest[] = []
  const steered: string[] = []
  const runner: AgentRunner = async (request) => {
    const gate = deferred<AgentRunResult>()
    gates.push(gate)
    started.push(request)
    request.onControl?.({
      steer: async (text) => {
        steered.push(text)
      }
    })
    request.signal?.addEventListener('abort', () => gate.reject(new AgentCancelledError('Wrapper')))
    return gate.promise
  }
  return {
    runner,
    started,
    steered,
    finish: (index, text = 'report') => gates[index].resolve({ text, toolCalls: 1 })
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function launch(
  registry: AgentRunRegistry,
  runner: AgentRunner,
  overrides: { background?: boolean; task?: string; signal?: AbortSignal } = {}
): { id: string; done: Promise<AgentRunSnapshot> } {
  return registry.launch({
    agent: 'Wrapper',
    task: overrides.task ?? 'go',
    runner,
    background: overrides.background ?? false,
    ...(overrides.signal ? { signal: overrides.signal } : {})
  })
}

// ── registry ─────────────────────────────────────────────────────────────

test('a launched run resolves to a done snapshot carrying the trimmed report', async () => {
  const registry = new AgentRunRegistry()
  const run = launch(registry, async () => ({ text: '  all done  ', toolCalls: 4 }))
  const snapshot = await run.done
  assert.equal(snapshot.id, run.id)
  assert.equal(snapshot.agent, 'Wrapper')
  assert.equal(snapshot.state, 'done')
  assert.equal(snapshot.report, 'all done')
  assert.equal(snapshot.toolCalls, 4)
  assert.ok(snapshot.completedAt !== undefined)
})

test('runs beyond maxConcurrent queue and start as slots free up', async () => {
  const registry = new AgentRunRegistry({ limits: { maxConcurrent: 2 } })
  const control = controlledRunner()
  const first = launch(registry, control.runner)
  const second = launch(registry, control.runner)
  const third = launch(registry, control.runner)
  await tick()

  assert.equal(control.started.length, 2)
  assert.equal(registry.get(third.id)?.state, 'queued')

  control.finish(0)
  await first.done
  await tick()
  assert.equal(control.started.length, 3)
  assert.equal(registry.get(third.id)?.state, 'running')

  control.finish(1)
  control.finish(2)
  assert.equal((await second.done).state, 'done')
  assert.equal((await third.done).state, 'done')
})

test('the registry refuses more runs than maxRuns', () => {
  const registry = new AgentRunRegistry({ limits: { maxRuns: 2 } })
  const control = controlledRunner()
  launch(registry, control.runner)
  launch(registry, control.runner)
  assert.throws(() => launch(registry, control.runner), AgentRunLimitError)
})

test('failures, timeouts and empty reports become error snapshots naming the agent', async () => {
  const registry = new AgentRunRegistry()
  const failed = await launch(registry, async () => {
    throw new Error('model unavailable')
  }).done
  assert.equal(failed.state, 'error')
  assert.match(failed.error ?? '', /Wrapper agent failed: model unavailable/)

  const timedOut = await launch(registry, async () => {
    throw new AgentTimeoutError('Wrapper', 60000)
  }).done
  assert.equal(timedOut.state, 'error')
  assert.match(timedOut.error ?? '', /timed out/)

  const empty = await launch(registry, async () => ({ text: '   ', toolCalls: 0 })).done
  assert.equal(empty.state, 'error')
  assert.match(empty.error ?? '', /no report/)
})

test('stop aborts a running run and cancels a queued one without ever starting it', async () => {
  const registry = new AgentRunRegistry({ limits: { maxConcurrent: 1 } })
  const control = controlledRunner()
  const running = launch(registry, control.runner)
  const queued = launch(registry, control.runner)
  await tick()

  assert.equal(registry.stop(queued.id), true)
  assert.equal((await queued.done).state, 'cancelled')
  assert.equal(control.started.length, 1)

  assert.equal(registry.stop(running.id), true)
  assert.equal((await running.done).state, 'cancelled')
  assert.equal(registry.stop(running.id), false, 'a finished run cannot be stopped again')
  assert.equal(registry.stop('run_missing'), false)
})

test('aborting the launch signal stops a foreground run but not a background one', async () => {
  const registry = new AgentRunRegistry()
  const control = controlledRunner()
  const foregroundAbort = new AbortController()
  const backgroundAbort = new AbortController()
  const foreground = launch(registry, control.runner, { signal: foregroundAbort.signal })
  const background = launch(registry, control.runner, {
    background: true,
    signal: backgroundAbort.signal
  })
  await tick()

  foregroundAbort.abort()
  backgroundAbort.abort()
  assert.equal((await foreground.done).state, 'cancelled')
  assert.equal(registry.get(background.id)?.state, 'running')

  control.finish(1)
  assert.equal((await background.done).state, 'done')
})

test('a signal that is already aborted cancels the run before it starts', async () => {
  const registry = new AgentRunRegistry()
  const control = controlledRunner()
  const abort = new AbortController()
  abort.abort()
  const run = launch(registry, control.runner, { signal: abort.signal })
  assert.equal((await run.done).state, 'cancelled')
  assert.equal(control.started.length, 0)
})

test('steer reaches a running run and is refused for queued, finished or unknown runs', async () => {
  const registry = new AgentRunRegistry({ limits: { maxConcurrent: 1 } })
  const control = controlledRunner()
  const running = launch(registry, control.runner)
  const queued = launch(registry, control.runner)
  await tick()

  await registry.steer(running.id, 'use the mouse genome')
  assert.deepEqual(control.steered, ['use the mouse genome'])
  await assert.rejects(registry.steer(queued.id, 'x'), /not started/i)
  await assert.rejects(registry.steer('run_missing', 'x'), /Unknown run/)

  control.finish(0)
  await running.done
  await assert.rejects(registry.steer(running.id, 'x'), /already finished/i)
})

test('steer explains when the run cannot be steered', async () => {
  const registry = new AgentRunRegistry()
  const gate = deferred<AgentRunResult>()
  const run = launch(registry, () => gate.promise)
  await tick()
  await assert.rejects(registry.steer(run.id, 'x'), /cannot be steered/i)
  gate.resolve({ text: 'ok', toolCalls: 0 })
  await run.done
})

test('progress from the runner is kept as the run’s last step', async () => {
  const registry = new AgentRunRegistry()
  const gate = deferred<AgentRunResult>()
  const run = launch(registry, async ({ onToolStep }) => {
    onToolStep?.({ id: 's1', toolName: 'wrapper_run', status: 'running', args: { id: 'fastqc' } })
    return gate.promise
  })
  await tick()
  assert.equal(registry.get(run.id)?.lastStep, 'wrapper_run fastqc')
  gate.resolve({ text: 'ok', toolCalls: 1 })
  await run.done
})

test('wait resolves when every targeted run has finished', async () => {
  const registry = new AgentRunRegistry()
  const control = controlledRunner()
  const a = launch(registry, control.runner)
  const b = launch(registry, control.runner)
  await tick()

  const waiting = registry.wait([a.id, b.id], { timeoutMs: 1000 })
  control.finish(0)
  control.finish(1)
  const result = await waiting
  assert.equal(result.timedOut, false)
  assert.deepEqual(
    result.runs.map((run) => run.state),
    ['done', 'done']
  )
})

test('wait in any mode returns as soon as one run has finished', async () => {
  const registry = new AgentRunRegistry()
  const control = controlledRunner()
  const a = launch(registry, control.runner)
  const b = launch(registry, control.runner)
  await tick()

  const waiting = registry.wait([a.id, b.id], { timeoutMs: 1000, mode: 'any' })
  control.finish(1)
  const result = await waiting
  assert.equal(result.timedOut, false)
  assert.deepEqual(
    result.runs.map((run) => run.state),
    ['running', 'done']
  )
  control.finish(0)
  await a.done
})

test('wait reports a timeout and leaves the runs going', async () => {
  const registry = new AgentRunRegistry()
  const control = controlledRunner()
  const run = launch(registry, control.runner)
  await tick()

  const result = await registry.wait([run.id], { timeoutMs: 10 })
  assert.equal(result.timedOut, true)
  assert.equal(result.runs[0].state, 'running')
  control.finish(0)
  await run.done
})

test('wait with no ids targets every unfinished run, and is empty when there are none', async () => {
  const registry = new AgentRunRegistry()
  assert.deepEqual(await registry.wait(undefined, { timeoutMs: 10 }), { runs: [], timedOut: false })

  const control = controlledRunner()
  launch(registry, control.runner)
  launch(registry, control.runner)
  await tick()
  const waiting = registry.wait(undefined, { timeoutMs: 1000 })
  control.finish(0)
  control.finish(1)
  assert.equal((await waiting).runs.length, 2)
})

test('wait stops early when its own signal aborts, without stopping the runs', async () => {
  const registry = new AgentRunRegistry()
  const control = controlledRunner()
  const run = launch(registry, control.runner)
  await tick()

  const abort = new AbortController()
  const waiting = registry.wait([run.id], { timeoutMs: 60000, signal: abort.signal })
  abort.abort()
  const result = await waiting
  assert.equal(result.timedOut, true)
  assert.equal(registry.get(run.id)?.state, 'running')
  control.finish(0)
  await run.done
})

test('stopAll cancels every unfinished run', async () => {
  const registry = new AgentRunRegistry({ limits: { maxConcurrent: 1 } })
  const control = controlledRunner()
  const a = launch(registry, control.runner)
  const b = launch(registry, control.runner)
  await tick()
  registry.stopAll()
  assert.equal((await a.done).state, 'cancelled')
  assert.equal((await b.done).state, 'cancelled')
})

// ── delegation tool ──────────────────────────────────────────────────────

test('the delegation tool offers an optional background flag', () => {
  const tool = buildAgentTool(WRAPPER, async () => ({ text: 'x', toolCalls: 0 }))
  const parameters = tool.parameters as {
    required: string[]
    properties: Record<string, { type: string }>
  }
  assert.deepEqual(parameters.required, ['task'])
  assert.equal(parameters.properties.background.type, 'boolean')
})

test('a background delegation returns its run id at once and keeps running', async () => {
  const registry = new AgentRunRegistry()
  const control = controlledRunner()
  const tool = buildAgentTool(WRAPPER, control.runner, registry)

  const result = await tool.execute('call', { task: 'align reads', background: true })
  assert.equal(result.isError, undefined)
  const details = result.details as { kind: string; agent: string; runId: string }
  assert.equal(details.kind, 'agent_started')
  assert.equal(details.agent, 'Wrapper')
  assert.match(JSON.stringify(result.content), new RegExp(details.runId))
  assert.equal(registry.get(details.runId)?.state, 'running')
  assert.equal(registry.get(details.runId)?.background, true)

  control.finish(0, 'aligned')
  assert.equal(
    (await registry.wait([details.runId], { timeoutMs: 1000 })).runs[0].report,
    'aligned'
  )
})

test('a background run does not push updates through the finished tool call', async () => {
  const registry = new AgentRunRegistry()
  const updates: string[] = []
  const gate = deferred<AgentRunResult>()
  let emit: ((line: string) => void) | undefined
  const tool = buildAgentTool(
    WRAPPER,
    async ({ onProgress }) => {
      emit = (line) => onProgress?.(line)
      return gate.promise
    },
    registry
  )
  await tool.execute(
    'call',
    { task: 'go', background: true },
    (partial: { content: Array<{ text: string }> }) => updates.push(partial.content[0].text),
    undefined as never
  )
  await tick()
  emit?.('late progress')
  gate.resolve({ text: 'ok', toolCalls: 0 })
  assert.deepEqual(updates, [])
})

test('a foreground delegation waits for the report, as before', async () => {
  const registry = new AgentRunRegistry()
  const result = await buildAgentTool(
    WRAPPER,
    async () => ({ text: 'report', toolCalls: 2 }),
    registry
  ).execute('call', { task: 'go' })
  assert.deepEqual(result.details, {
    kind: 'agent_result',
    agent: 'Wrapper',
    status: 'completed',
    missingInputs: [],
    toolCalls: 2
  })
  assert.equal(registry.list()[0].background, false)
})

test('parallel delegations in the same turn run together and share the concurrency limit', async () => {
  const registry = new AgentRunRegistry({ limits: { maxConcurrent: 2 } })
  const control = controlledRunner()
  const tool = buildAgentTool(WRAPPER, control.runner, registry)
  const calls = [1, 2, 3].map((n) => tool.execute(`call-${n}`, { task: `task ${n}` }))
  await tick()
  assert.equal(control.started.length, 2)
  control.finish(0)
  await tick()
  assert.equal(control.started.length, 3)
  control.finish(1)
  control.finish(2)
  const results = await Promise.all(calls)
  assert.ok(results.every((result) => result.isError === undefined))
})

test('the delegation tool reports a run limit as an error instead of throwing', async () => {
  const registry = new AgentRunRegistry({ limits: { maxRuns: 1 } })
  const tool = buildAgentTool(WRAPPER, async () => ({ text: 'x', toolCalls: 0 }), registry)
  await tool.execute('call', { task: 'one' })
  const result = await tool.execute('call', { task: 'two' })
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result.content), /limit/i)
})

// ── run management tools ─────────────────────────────────────────────────

function toolByName(registry: AgentRunRegistry, name: string): CustomTool {
  const tool = buildAgentRunTools(registry).find((candidate) => candidate.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}

const textOf = (result: { content: unknown }): string =>
  (result.content as Array<{ text: string }>).map((part) => part.text).join('')

test('the run management tools are always visible to the leader and need no approval', () => {
  const tools = buildAgentRunTools(new AgentRunRegistry())
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['agent_status', 'agent_wait', 'agent_steer', 'agent_stop']
  )
  for (const tool of tools) {
    assert.equal(tool.approval, 'read')
    assert.equal((tool as { loadMode?: string }).loadMode, 'essential')
  }
})

test('agent_status lists every run, or shows one run with its report', async () => {
  const registry = new AgentRunRegistry()
  const control = controlledRunner()
  const running = launch(registry, control.runner, { background: true, task: 'align reads' })
  const finished = launch(registry, async () => ({ text: 'FastQC is clean.', toolCalls: 1 }))
  await finished.done
  await tick()

  const list = textOf(await toolByName(registry, 'agent_status').execute('c', {}))
  assert.match(list, new RegExp(`${running.id}.*Wrapper.*running`))
  assert.match(list, new RegExp(`${finished.id}.*Wrapper.*done`))

  const one = textOf(await toolByName(registry, 'agent_status').execute('c', { id: finished.id }))
  assert.match(one, /FastQC is clean\./)

  const missing = await toolByName(registry, 'agent_status').execute('c', { id: 'run_nope' })
  assert.equal(missing.isError, true)

  control.finish(0)
  await running.done
})

test('agent_status says so when no agent has run yet', async () => {
  const text = textOf(await toolByName(new AgentRunRegistry(), 'agent_status').execute('c', {}))
  assert.match(text, /No agent runs/i)
})

test('agent_wait returns finished reports and flags what is still running', async () => {
  const registry = new AgentRunRegistry()
  const control = controlledRunner()
  const a = launch(registry, control.runner, { background: true })
  const b = launch(registry, control.runner, { background: true })
  await tick()
  control.finish(0, 'Alpha report')

  const partial = textOf(
    await toolByName(registry, 'agent_wait').execute('c', {
      ids: [a.id, b.id],
      timeout_seconds: 0.01
    })
  )
  assert.match(partial, /Alpha report/)
  assert.match(partial, /still running/i)

  control.finish(1, 'Beta report')
  const full = textOf(await toolByName(registry, 'agent_wait').execute('c', { ids: [a.id, b.id] }))
  assert.match(full, /Beta report/)
  assert.doesNotMatch(full, /still running/i)
})

test('agent_wait rejects an unknown id', async () => {
  const result = await toolByName(new AgentRunRegistry(), 'agent_wait').execute('c', {
    ids: ['run_nope']
  })
  assert.equal(result.isError, true)
})

test('agent_steer delivers the message to a running agent and rejects a bad request', async () => {
  const registry = new AgentRunRegistry()
  const control = controlledRunner()
  const run = launch(registry, control.runner, { background: true })
  await tick()

  const tool = toolByName(registry, 'agent_steer')
  const ok = await tool.execute('c', { id: run.id, message: 'skip the QC step' })
  assert.equal(ok.isError, undefined)
  assert.deepEqual(control.steered, ['skip the QC step'])

  assert.equal((await tool.execute('c', { id: run.id, message: '   ' })).isError, true)
  assert.equal((await tool.execute('c', { id: 'run_nope', message: 'x' })).isError, true)

  control.finish(0)
  await run.done
  assert.equal((await tool.execute('c', { id: run.id, message: 'late' })).isError, true)
})

test('agent_stop cancels a running agent', async () => {
  const registry = new AgentRunRegistry()
  const control = controlledRunner()
  const run = launch(registry, control.runner, { background: true })
  await tick()

  const tool = toolByName(registry, 'agent_stop')
  const stopped = await tool.execute('c', { id: run.id })
  assert.equal(stopped.isError, undefined)
  assert.equal((await run.done).state, 'cancelled')

  const again = await tool.execute('c', { id: run.id })
  assert.equal(again.isError, true)
})

// ── runner control channel ───────────────────────────────────────────────

function steerableSession(): AgentSessionLike & { steered: string[] } {
  const listeners = new Set<(event: unknown) => void>()
  const steered: string[] = []
  return {
    steered,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    prompt: async () => undefined,
    async steer(text: string) {
      steered.push(text)
    },
    abort: async () => undefined,
    dispose: async () => undefined,
    getLastAssistantMessage: () => ({ stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] })
  }
}

test('the runner hands its session’s steer to the caller once the session exists', async () => {
  const session = steerableSession()
  const controls: Array<{ steer: (text: string) => Promise<void> }> = []
  await createAgentRunner({ agent: 'Wrapper', createSession: async () => session })({
    task: 'go',
    onControl: (control) => controls.push(control)
  })
  assert.equal(controls.length, 1)
  await controls[0].steer('change course')
  assert.deepEqual(session.steered, ['change course'])
})

test('a session without steer support rejects steering with a clear message', async () => {
  const session = steerableSession()
  delete (session as { steer?: unknown }).steer
  let control: { steer: (text: string) => Promise<void> } | undefined
  await createAgentRunner({ agent: 'Wrapper', createSession: async () => session })({
    task: 'go',
    onControl: (c) => {
      control = c
    }
  })
  await assert.rejects(control!.steer('x'), /cannot be steered/i)
})

// ── leader prompt ────────────────────────────────────────────────────────

test('the leader prompt teaches parallel and background delegation and the run tools', () => {
  const prompt = buildAgentLeaderPrompt([WRAPPER])
  assert.match(prompt, /background/)
  assert.match(prompt, /same turn|in parallel/i)
  for (const name of ['agent_status', 'agent_wait', 'agent_steer', 'agent_stop']) {
    assert.match(prompt, new RegExp(name))
  }
})

// ── listeners and read receipts (drive the automatic wake-up) ────────────

test('listeners hear about every run that ends, however it ends', async () => {
  const registry = new AgentRunRegistry()
  const seen: string[] = []
  registry.subscribe({ onFinish: (run) => seen.push(`${run.id}:${run.state}`) })

  await launch(registry, async () => ({ text: 'ok', toolCalls: 0 })).done
  await launch(registry, async () => {
    throw new Error('boom')
  }).done
  const control = controlledRunner()
  const stopped = launch(registry, control.runner)
  await tick()
  registry.stop(stopped.id)
  await stopped.done

  assert.deepEqual(seen, ['run_1:done', 'run_2:error', 'run_3:cancelled'])
})

test('a listener that throws neither breaks the run nor the other listeners', async () => {
  const registry = new AgentRunRegistry()
  const seen: string[] = []
  registry.subscribe({
    onFinish: () => {
      throw new Error('listener bug')
    }
  })
  registry.subscribe({ onFinish: (run) => seen.push(run.id) })
  const run = await launch(registry, async () => ({ text: 'ok', toolCalls: 0 })).done
  assert.equal(run.state, 'done')
  assert.deepEqual(seen, ['run_1'])
})

test('unsubscribing stops the notifications', async () => {
  const registry = new AgentRunRegistry()
  const seen: string[] = []
  const unsubscribe = registry.subscribe({ onFinish: (run) => seen.push(run.id) })
  unsubscribe()
  await launch(registry, async () => ({ text: 'ok', toolCalls: 0 })).done
  assert.deepEqual(seen, [])
})

test('markReported flags a finished run once and tells the listeners', async () => {
  const registry = new AgentRunRegistry()
  const reported: string[] = []
  registry.subscribe({ onReported: (run) => reported.push(run.id) })
  const control = controlledRunner()
  const running = launch(registry, control.runner)
  await tick()

  assert.equal(registry.markReported(running.id), false, 'a running run has no report to hand over')
  assert.equal(registry.markReported('run_missing'), false)

  control.finish(0)
  await running.done
  assert.equal(registry.markReported(running.id), true)
  assert.equal(registry.markReported(running.id), false, 'only the first hand-over counts')
  assert.equal(registry.get(running.id)?.reported, true)
  assert.deepEqual(reported, [running.id])
})

test('agent_wait and agent_status <id> hand a finished run’s report over; the plain list does not', async () => {
  const registry = new AgentRunRegistry()
  const a = launch(registry, async () => ({ text: 'A done', toolCalls: 0 }), { background: true })
  const b = launch(registry, async () => ({ text: 'B done', toolCalls: 0 }), { background: true })
  const c = launch(registry, async () => ({ text: 'C done', toolCalls: 0 }), { background: true })
  await Promise.all([a.done, b.done, c.done])

  await toolByName(registry, 'agent_status').execute('x', {})
  assert.equal(registry.get(a.id)?.reported, undefined)

  await toolByName(registry, 'agent_status').execute('x', { id: b.id })
  assert.equal(registry.get(b.id)?.reported, true)

  await toolByName(registry, 'agent_wait').execute('x', { ids: [a.id] })
  assert.equal(registry.get(a.id)?.reported, true)
  assert.equal(registry.get(c.id)?.reported, undefined)
})

test('the leader is told that Phi reports a finished background run, so it need not poll', () => {
  assert.match(buildAgentLeaderPrompt([WRAPPER]), /Phi sends you a message with its report/)
})

test('a background start tells the agent not to poll', async () => {
  const registry = new AgentRunRegistry()
  const tool = buildAgentTool(
    WRAPPER,
    async () => new Promise<AgentRunResult>(() => undefined),
    registry
  )
  const result = await tool.execute('call', { task: 'go', background: true })
  assert.match(JSON.stringify(result.content), /do not poll/)
  registry.stopAll()
})

// ── run ids on steps, tool call ids, step listeners (drive the card) ─────

test('a run remembers the tool call that delegated it', async () => {
  const registry = new AgentRunRegistry()
  const run = registry.launch({
    agent: 'Wrapper',
    task: 'go',
    runner: async () => ({ text: 'ok', toolCalls: 0 }),
    background: true,
    toolCallId: 'call-42'
  })
  assert.equal(registry.get(run.id)?.toolCallId, 'call-42')
  assert.equal((await run.done).toolCallId, 'call-42')
})

test('listeners hear every tool step of every run, with the run they belong to', async () => {
  const registry = new AgentRunRegistry()
  const seen: string[] = []
  registry.subscribe({
    onStep: (run, step) => seen.push(`${run.id}:${step.toolName}:${step.status}`)
  })
  await launch(registry, async ({ onToolStep }) => {
    onToolStep?.({ id: 's1', toolName: 'read', status: 'running' })
    onToolStep?.({ id: 's1', toolName: 'read', status: 'done', output: 'x' })
    return { text: 'ok', toolCalls: 1 }
  }).done
  assert.deepEqual(seen, ['run_1:read:running', 'run_1:read:done'])
})

test('a step listener that throws does not break the run', async () => {
  const registry = new AgentRunRegistry()
  registry.subscribe({
    onStep: () => {
      throw new Error('listener bug')
    }
  })
  const run = await launch(registry, async ({ onToolStep }) => {
    onToolStep?.({ id: 's1', toolName: 'read', status: 'running' })
    return { text: 'ok', toolCalls: 1 }
  }).done
  assert.equal(run.state, 'done')
})

test('foreground progress and step updates carry the run id and the tool call id is recorded', async () => {
  const registry = new AgentRunRegistry()
  const updates: Array<{ details: { kind: string; agentRunId?: string } }> = []
  const tool = buildAgentTool(
    WRAPPER,
    async ({ onProgress, onToolStep }) => {
      onProgress?.('reading')
      onToolStep?.({ id: 's1', toolName: 'read', status: 'running' })
      return { text: 'ok', toolCalls: 1 }
    },
    registry
  )
  await tool.execute(
    'call-7',
    { task: 'go' },
    (partial: { details: { kind: string; agentRunId?: string } }) => updates.push(partial),
    undefined as never
  )
  assert.deepEqual(
    updates.map((update) => [update.details.kind, update.details.agentRunId]),
    [
      ['agent_progress', 'run_1'],
      ['agent_step', 'run_1']
    ]
  )
  assert.equal(registry.get('run_1')?.toolCallId, 'call-7')
})

// ── card controls reaching a run in the worker ───────────────────────────

test('controlAgentRun steers a running agent through its session’s registry', async () => {
  const registry = new AgentRunRegistry()
  const control = controlledRunner()
  const run = launch(registry, control.runner, { background: true })
  await tick()

  assert.deepEqual(
    await controlAgentRun(registry, 'steer', { runId: run.id, message: 'use hg38' }),
    { ok: true }
  )
  assert.deepEqual(control.steered, ['use hg38'])
  control.finish(0)
  await run.done
})

test('controlAgentRun stops a running agent', async () => {
  const registry = new AgentRunRegistry()
  const control = controlledRunner()
  const run = launch(registry, control.runner, { background: true })
  await tick()

  assert.deepEqual(await controlAgentRun(registry, 'stop', { runId: run.id }), { ok: true })
  assert.equal((await run.done).state, 'cancelled')
})

test('controlAgentRun explains why a run cannot be controlled', async () => {
  const registry = new AgentRunRegistry()
  const done = launch(registry, async () => ({ text: 'ok', toolCalls: 0 }))
  await done.done

  await assert.rejects(
    controlAgentRun(undefined, 'steer', { runId: 'run_1', message: 'x' }),
    /no longer running/i
  )
  await assert.rejects(controlAgentRun(registry, 'stop', { runId: done.id }), /already finished/i)
  await assert.rejects(
    controlAgentRun(registry, 'steer', { runId: done.id, message: 'x' }),
    /already finished/i
  )
  await assert.rejects(controlAgentRun(registry, 'stop', { runId: 'run_nope' }), /Unknown run/)
  await assert.rejects(controlAgentRun(registry, 'steer', { runId: done.id }), /message/)
  await assert.rejects(controlAgentRun(registry, 'stop', {}), /runId/)
})

// ── timing steps: the SDK's events carry no time ─────────────────────────

function emittingSession(script: (emit: (event: unknown) => void) => void): AgentSessionLike {
  const listeners = new Set<(event: unknown) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    prompt: async () => {
      script((event) => listeners.forEach((listener) => listener(event)))
    },
    abort: async () => undefined,
    dispose: async () => undefined,
    getLastAssistantMessage: () => ({ stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] })
  }
}

test('the runner times a step itself, since the SDK’s events carry no time', async () => {
  const clock = ['2026-09-20T10:00:00.000Z', '2026-09-20T10:00:05.000Z', '2026-09-20T10:00:09.000Z']
  let tick = 0
  const steps: Array<{ id: string; status: string; createdAt?: string; completedAt?: string }> = []
  await createAgentRunner({
    agent: 'Wrapper',
    now: () => clock[Math.min(tick++, clock.length - 1)],
    createSession: async () =>
      emittingSession((emit) => {
        emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} })
        emit({
          type: 'tool_execution_update',
          toolCallId: 't1',
          toolName: 'bash',
          partialResult: 'x'
        })
        emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: 'done' })
      })
  })({ task: 'go', onToolStep: (step) => steps.push(step) })

  const [start, update, end] = steps
  assert.equal(start.createdAt, '2026-09-20T10:00:00.000Z')
  assert.equal(update.createdAt, '2026-09-20T10:00:00.000Z', 'an update keeps the step’s own start')
  assert.equal(end.createdAt, '2026-09-20T10:00:00.000Z')
  assert.equal(end.completedAt, '2026-09-20T10:00:05.000Z')
})

test('a time the event already carries is used as it is', async () => {
  const steps: Array<{ createdAt?: string; completedAt?: string }> = []
  await createAgentRunner({
    agent: 'Wrapper',
    now: () => '2099-01-01T00:00:00.000Z',
    createSession: async () =>
      emittingSession((emit) => {
        emit({
          type: 'tool_execution_start',
          toolCallId: 't1',
          toolName: 'bash',
          args: {},
          createdAt: '2026-01-01T00:00:00.000Z'
        })
        emit({
          type: 'tool_execution_end',
          toolCallId: 't1',
          toolName: 'bash',
          result: 'x',
          createdAt: '2026-01-01T00:00:03.000Z'
        })
      })
  })({ task: 'go', onToolStep: (step) => steps.push(step) })
  assert.equal(steps[0].createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(steps[1].completedAt, '2026-01-01T00:00:03.000Z')
})
