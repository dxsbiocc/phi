import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { PhiAgentDefinition } from '../../src/main/agent/agents/definition'
import type { PhiSessionCreateParams, WorkerSessionState } from '../../src/main/agent/engine/types'
import type { EngineFactory, EngineFixture } from './in-process-factory'

export function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value))
  return value.map(record)
}
function text(value: unknown): string {
  const content = record(value).content
  if (typeof content === 'string') return content
  return records(content)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}
function toolResult(state: WorkerSessionState, name: string): Record<string, unknown> {
  const result = state.messages
    ?.map(record)
    .find((item) => item.role === 'toolResult' && item.toolName === name)
  assert.ok(result, `Missing ${name} tool result: ${JSON.stringify(state.messages)}`)
  return result
}
async function within<T>(promise: Promise<T>, label: string, ms = 10000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
function params(
  f: EngineFixture,
  sessionId = 'contract',
  patch: Partial<PhiSessionCreateParams> = {}
): PhiSessionCreateParams {
  return {
    sessionId,
    cwd: f.cwd,
    agentDir: f.agentDir,
    model: f.model,
    sessionManager: { kind: 'memory', cwd: f.cwd },
    resourceOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true
    },
    enableToolApproval: false,
    autoCompaction: { enabled: false },
    ...patch
  }
}
function events(f: EngineFixture, sessionId = 'contract'): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  f.engine.events.onSessionEvent(sessionId, (event) => result.push(record(event)))
  return result
}
function completedTool(items: Record<string, unknown>[], name: string): Record<string, unknown> {
  const event = items.find((item) => item.type === 'tool_execution_end' && item.toolName === name)
  assert.ok(event, `Missing completion for ${name}: ${JSON.stringify(items)}`)
  return event
}

function shellLiteral(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}
function boundSpecialist(f: EngineFixture, name: string): PhiAgentDefinition {
  return {
    name,
    description: 'Inspect the native bash contract.',
    tools: ['bash'],
    skills: [],
    environment: name,
    systemPrompt: 'Run the requested bash command.',
    source: 'phi',
    filePath: join(f.cwd, `${name}.md`),
    visibility: 'entry',
    warnings: []
  }
}
function approveTools(f: EngineFixture, sessionId = 'contract'): Record<string, unknown>[] {
  const approvals: Record<string, unknown>[] = []
  f.engine.events.onToolApproval(sessionId, (value) => {
    const approval = record(value)
    approvals.push(approval)
    void f.engine.events.respondToolApproval(String(approval.requestId), null)
  })
  return approvals
}
function modelToolOutput(f: EngineFixture, id: string): string {
  const message = f.provider.requests
    .flatMap((request) => request.messages)
    .find((item) => item.role === 'tool' && item.tool_call_id === id)
  assert.ok(message, `Missing model-visible native tool result ${id}`)
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}
function childSteps(items: Record<string, unknown>[]): Record<string, unknown>[] {
  return items
    .filter((item) => item.type === 'tool_execution_update')
    .map((item) => record(record(item.partialResult).details))
    .filter((details) => details.kind === 'agent_step')
    .map((details) => record(details.step))
}
function outputFields(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .split('\n')
      .filter((line) => /^[a-z]+=/.test(line))
      .map((line) => {
        const index = line.indexOf('=')
        return [line.slice(0, index), line.slice(index + 1)]
      })
  )
}

/** The factory is the only engine-specific seam; these cases never import OMP. */
export function engineContract(name: string, factory: EngineFactory): void {
  const contract = (
    title: string,
    run: (f: EngineFixture, t: TestContext) => Promise<void>,
    modelId?: string
  ): void => {
    test(`${name}: ${title}`, { timeout: 30000 }, async (t) => {
      const f = await factory(modelId)
      t.after(() => f.close())
      try {
        await run(f, t)
      } finally {
        await f.close()
      }
    })
  }

  contract('streams one turn and a host tool lifecycle in order', async (f) => {
    const calls: unknown[] = []
    f.engine.host.register('notebookTool.execute', (request) => {
      calls.push(request)
      return { summary: 'notebook found', cells: [] }
    })
    const observed = events(f)
    await f.engine.sessions.create(params(f))
    assert.equal(f.engine.sessions.has('contract'), true)
    f.provider.enqueue(
      { text: 'Checking notebook.', tool: { name: 'notebook.read', args: { path: 'demo.ipynb' } } },
      { text: 'Notebook checked.' }
    )
    const state = await f.engine.sessions.prompt({
      sessionId: 'contract',
      text: 'Inspect the notebook.'
    })
    const types = observed.map((item) => item.type)
    const start = types.indexOf('agent_start')
    const toolStart = types.indexOf('tool_execution_start')
    const toolEnd = types.indexOf('tool_execution_end')
    assert.ok(
      start >= 0 &&
        start < toolStart &&
        toolStart < toolEnd &&
        toolEnd < types.lastIndexOf('agent_end'),
      JSON.stringify(types)
    )
    const deltas = observed
      .slice(0, toolStart)
      .filter((item) => item.type === 'message_update')
      .map((item) => record(item.assistantMessageEvent))
      .filter((item) => item.type === 'text_delta')
    assert.ok(deltas.length >= 2, 'Expected at least two text deltas before the first tool starts')
    assert.deepEqual(record(calls[0]).params, { path: 'demo.ipynb' })
    assert.equal(record(calls[0]).cwd, f.cwd)
    assert.equal(completedTool(observed, 'notebook.read').isError, false)
    assert.match(text(toolResult(state, 'notebook.read')), /notebook found/)
    assert.equal(text(state.messages!.at(-1)), 'Notebook checked.')
    assert.equal(f.provider.requests.length, 2)
    assert.ok(
      f.provider.requests[1].messages.some(
        (message) => message.role === 'tool' && String(message.content).includes('notebook found')
      )
    )
    await f.engine.sessions.dispose({ sessionId: 'contract' })
    assert.equal(f.engine.sessions.has('contract'), false)
  })

  contract('filters undeclared host arguments before callback', async (f) => {
    const calls: unknown[] = []
    f.engine.host.register('notebookTool.execute', (request) => {
      calls.push(request)
      return 'ok'
    })
    await f.engine.sessions.create(params(f))
    f.provider.enqueue(
      {
        tool: {
          name: 'notebook.read',
          args: {
            path: 'demo.ipynb',
            includeOutputs: false,
            forged: 'drop-me',
            __intent: 'Inspect notebook'
          }
        }
      },
      { text: 'Done.' }
    )
    await f.engine.sessions.prompt({ sessionId: 'contract', text: 'Read notebook.' })
    assert.equal(calls.length, 1)
    assert.deepEqual(record(calls[0]).params, { path: 'demo.ipynb', includeOutputs: false })
  })

  contract('preserves host failure text and isError in event and history', async (f) => {
    f.engine.host.register('notebookTool.execute', () => {
      throw new Error('contract notebook unavailable')
    })
    const observed = events(f)
    await f.engine.sessions.create(params(f))
    f.provider.enqueue(
      { tool: { name: 'notebook.read', args: { path: 'missing.ipynb' } } },
      { text: 'Unable to read.' }
    )
    const state = await f.engine.sessions.prompt({
      sessionId: 'contract',
      text: 'Read missing notebook.'
    })
    const completion = completedTool(observed, 'notebook.read')
    assert.equal(completion.isError, true)
    assert.match(text(completion.result), /contract notebook unavailable/)
    const result = toolResult(state, 'notebook.read')
    assert.equal(result.isError, true)
    assert.match(text(result), /contract notebook unavailable/)
  })

  contract('aborts a streaming turn and can run the next turn', async (f) => {
    const observed = events(f)
    await f.engine.sessions.create(params(f, 'contract', { noTools: 'all' }))
    f.provider.enqueue({ text: 'Partial response', hold: true })
    const prompt = f.engine.sessions.prompt({
      sessionId: 'contract',
      text: 'Start a long response.'
    })
    void prompt.catch(() => undefined)
    await until(
      () =>
        observed.some(
          (item) =>
            item.type === 'message_update' &&
            record(item.assistantMessageEvent).type === 'text_delta'
        ),
      'first streaming update'
    )
    const aborted = await within(f.engine.sessions.abort({ sessionId: 'contract' }), 'abort')
    await within(prompt, 'interrupted prompt')
    assert.ok(observed.some((item) => item.type === 'agent_end'))
    assert.ok(
      aborted.messages
        ?.map(record)
        .some((item) => item.role === 'assistant' && item.stopReason === 'aborted')
    )
    f.provider.enqueue({ text: 'Next turn works.' })
    const state = await f.engine.sessions.prompt({ sessionId: 'contract', text: 'Continue.' })
    assert.equal(text(state.messages!.at(-1)), 'Next turn works.')
  })

  for (const decision of ['approve', 'deny', 'cancel'] as const) {
    contract(
      `${decision === 'deny' ? 'denies' : `${decision}s`} a main-session write approval`,
      async (f) => {
        let writes = 0
        f.engine.host.register('notebookTool.execute', () => {
          writes++
          return 'saved'
        })
        const observed = events(f)
        const approvals: Record<string, unknown>[] = []
        f.engine.events.onToolApproval('contract', (request) => approvals.push(record(request)))
        await f.engine.sessions.create(params(f, 'contract', { enableToolApproval: true }))
        f.provider.enqueue(
          { tool: { name: 'notebook.save', id: 'write-call', args: { path: 'demo.ipynb' } } },
          ...(decision === 'cancel' ? [] : [{ text: 'Write handled.' }])
        )
        const prompt = f.engine.sessions.prompt({ sessionId: 'contract', text: 'Save notebook.' })
        void prompt.catch(() => undefined)
        await until(() => approvals.length > 0, 'write approval')
        assert.equal(approvals[0].toolName, 'notebook.save')
        assert.equal(approvals[0].toolCallId, 'write-call')
        assert.deepEqual(approvals[0].input, { path: 'demo.ipynb' })
        assert.equal(writes, 0)
        if (decision === 'cancel') {
          const state = await within(
            f.engine.sessions.abort({ sessionId: 'contract' }),
            'abort pending approval',
            2000
          )
          await within(prompt, 'cancelled approval prompt', 2000)
          assert.ok(
            state.messages
              ?.map(record)
              .some((item) => item.role === 'assistant' && item.stopReason === 'aborted')
          )
          await f.engine.events.respondToolApproval(String(approvals[0].requestId), null)
          assert.equal(writes, 0, 'A late approval must not execute the cancelled write')
          assert.ok(observed.some((item) => item.type === 'agent_end'))
          f.provider.enqueue({ text: 'After cancellation.' })
          const resumed = await f.engine.sessions.prompt({
            sessionId: 'contract',
            text: 'Continue after cancellation.'
          })
          assert.equal(text(resumed.messages!.at(-1)), 'After cancellation.')
          assert.equal(writes, 0, 'Cancelled write must stay cancelled after another turn')
        } else {
          await f.engine.events.respondToolApproval(
            String(approvals[0].requestId),
            decision === 'approve' ? null : { block: true, reason: 'Contract user denied' }
          )
          const state = await within(prompt, 'approval result')
          assert.equal(writes, decision === 'approve' ? 1 : 0)
          const result = toolResult(state, 'notebook.save')
          assert.equal(result.isError, decision === 'deny')
          assert.equal(completedTool(observed, 'notebook.save').isError, decision === 'deny')
          assert.match(text(result), decision === 'deny' ? /Contract user denied/ : /saved/)
        }
      }
    )
  }

  contract(
    'delegates a real child session, forwards its steps and returns its report',
    async (f) => {
      const observed = events(f)
      writeFileSync(join(f.cwd, 'child.txt'), 'child file evidence')
      await f.engine.sessions.create(
        params(f, 'contract', {
          phiAgents: [
            {
              name: 'ContractSpecialist',
              description: 'Read the contract fixture.',
              tools: ['read'],
              skills: [],
              systemPrompt: 'Read child.txt then report.',
              source: 'phi',
              filePath: join(f.cwd, 'ContractSpecialist.md'),
              visibility: 'entry',
              warnings: []
            }
          ]
        })
      )
      f.provider.enqueue(
        { tool: { name: 'ContractSpecialist', args: { task: 'Read child.txt and report.' } } },
        { tool: { name: 'read', args: { path: join(f.cwd, 'child.txt') } } },
        { text: 'Child read child file evidence.' },
        { text: 'Main received child report.' }
      )
      const state = await f.engine.sessions.prompt({
        sessionId: 'contract',
        text: 'Delegate a file inspection.'
      })
      const result = toolResult(state, 'ContractSpecialist')
      assert.equal(result.isError, false)
      assert.match(text(result), /Child read child file evidence/)
      const updates = observed.filter(
        (item) => item.type === 'tool_execution_update' && item.toolName === 'ContractSpecialist'
      )
      assert.ok(
        updates.some((item) => JSON.stringify(item.partialResult).includes('read')),
        'Missing forwarded child step'
      )
      assert.equal(completedTool(observed, 'ContractSpecialist').isError, false)
      assert.equal(text(state.messages!.at(-1)), 'Main received child report.')
      assert.equal(f.provider.requests.length, 5)
      assert.match(JSON.stringify(f.provider.requests[1].messages), /Is this specialist suitable/)
      assert.equal(f.provider.requests[1].tools, undefined)
      assert.ok(
        f.provider.requests[3].messages.some(
          (item) => item.role === 'tool' && String(item.content).includes('child file evidence')
        )
      )
    }
  )

  contract(
    'isolates native bash in bound specialists and preserves baseline shell state',
    async (f) => {
      const bindings: string[] = []
      const injected = join(f.cwd, 'injected.txt')
      const malicious = `quote'value;$(printf injected > ${shellLiteral(injected)})`
      f.engine.host.register('environments.bindSession', (request) => {
        const body = record(request)
        const name = String(body.agent)
        const ref = String(body.ref)
        bindings.push(ref)
        return {
          ref,
          variables: {
            PATH: `${join(f.cwd, name, 'bin')}:/usr/bin:/bin`,
            HOME: f.cwd,
            PHI_CONTRACT_BOUND: ref === 'BoundOne-v2' ? 'two' : 'one',
            PHI_CONTRACT_QUOTED: malicious,
            ...(ref === 'BoundOne' ? { PHI_CONTRACT_OVERLAY: 'first' } : {})
          }
        }
      })
      f.engine.host.register('environments.request', (request) => {
        assert.equal(record(request).environment, 'BoundOne')
        return {
          ref: 'BoundOne-v2',
          envId: 'fixture-v2',
          name: 'Fixture',
          added: ['fixture-package']
        }
      })
      const approvals = approveTools(f)
      const observed = events(f)
      await f.engine.sessions.create(
        params(f, 'contract', {
          enableToolApproval: true,
          phiAgents: ['BoundOne', 'BoundTwo'].map((name) => boundSpecialist(f, name))
        })
      )
      mkdirSync(join(f.cwd, 'nested'))
      const inspect =
        'printf "cwd=%s\\npath=%s\\nbound=%s\\noverlay=%s\\nquoted=%s\\nsecret=%s\\npythonpath=%s\\nuser=%s\\n" "$PWD" "$PATH" "$PHI_CONTRACT_BOUND" "${PHI_CONTRACT_OVERLAY-missing}" "$PHI_CONTRACT_QUOTED" "${PHI_CONTRACT_HOST_SECRET-missing}" "${PYTHONPATH-missing}" "${PHI_USER_EXPORT-missing}"'
      const first = `cd nested; export PHI_USER_EXPORT=persisted; ${inspect}`
      f.provider.enqueue(
        { tool: { name: 'BoundOne', args: { task: 'Inspect, rebind, then inspect again.' } } },
        { tool: { name: 'bash', id: 'bound-first', args: { command: first } } },
        { tool: { name: 'bash', id: 'bound-same', args: { command: inspect } } },
        {
          tool: {
            name: 'env_request',
            args: { packages: ['fixture-package'], reason: 'Contract rebind' }
          }
        },
        { tool: { name: 'bash', id: 'bound-rebound', args: { command: inspect } } },
        { text: 'First binding verified.' },
        { tool: { name: 'BoundTwo', args: { task: 'Inspect isolated second child.' } } },
        { tool: { name: 'bash', id: 'bound-second-child', args: { command: inspect } } },
        { text: 'Second binding verified.' },
        { text: 'Bound specialists complete.' }
      )
      const state = await f.engine.sessions.prompt({
        sessionId: 'contract',
        text: 'Inspect both bindings.'
      })
      assert.equal(text(state.messages!.at(-1)), 'Bound specialists complete.')
      assert.deepEqual(bindings, ['BoundOne', 'BoundOne-v2', 'BoundTwo'])
      assert.deepEqual(
        approvals
          .filter((item) => item.toolName === 'bash')
          .map((item) => record(item.input).command),
        [first, inspect, inspect, inspect]
      )
      const [one, same, rebound, two] = [
        'bound-first',
        'bound-same',
        'bound-rebound',
        'bound-second-child'
      ].map((id) => outputFields(modelToolOutput(f, id)))
      assert.equal(realpathSync(one.cwd), realpathSync(join(f.cwd, 'nested')))
      assert.equal(
        realpathSync(rebound.cwd),
        realpathSync(f.cwd),
        'Each native call resets cwd to the project root'
      )
      assert.equal(one.user, 'persisted')
      assert.equal(same.user, 'persisted', 'User exports must persist before rebinding too')
      assert.equal(realpathSync(same.cwd), realpathSync(f.cwd))
      assert.equal(same.bound, 'one')
      assert.equal(same.overlay, 'first')
      assert.equal(rebound.user, 'persisted', 'User exports must persist across native calls')
      assert.equal(one.bound, 'one')
      assert.equal(one.overlay, 'first')
      assert.equal(rebound.bound, 'two', 'Rebinding must affect the next native call')
      assert.equal(rebound.overlay, 'missing', 'The previous binding overlay must be revoked')
      assert.equal(two.user, 'missing', 'Another child session must not inherit a user export')
      assert.equal(two.bound, 'one')
      for (const fields of [one, same, rebound, two]) {
        assert.equal(fields.quoted, malicious)
        assert.equal(fields.secret, 'missing')
        assert.equal(fields.pythonpath, 'missing')
        assert.ok(
          fields.path.startsWith(join(f.cwd, fields === two ? 'BoundTwo' : 'BoundOne', 'bin'))
        )
      }
      assert.equal(existsSync(injected), false, 'Quoted binding values must never execute')
      const completed = childSteps(observed).filter(
        (step) => step.toolName === 'bash' && step.status === 'done'
      )
      assert.equal(completed.length, 4)
    }
  )

  contract('keeps native shell state isolated between two parent sessions', async (f) => {
    f.engine.host.register('environments.bindSession', (request) => ({
      ref: String(record(request).ref),
      variables: { PATH: '/usr/bin:/bin', HOME: f.cwd }
    }))
    for (const sessionId of ['parent-one', 'parent-two']) {
      await f.engine.sessions.create(
        params(f, sessionId, { phiAgents: [boundSpecialist(f, 'BoundCheck')] })
      )
    }
    const commands = [
      'export PHI_USER_SESSION=first; printf "session=%s\\n" "$PHI_USER_SESSION"',
      'printf "session=%s\\n" "${PHI_USER_SESSION-missing}"'
    ]
    for (const [index, sessionId] of ['parent-one', 'parent-two'].entries()) {
      f.provider.enqueue(
        { tool: { name: 'BoundCheck', args: { task: 'Inspect your shell state.' } } },
        { tool: { name: 'bash', id: `parent-bash-${index}`, args: { command: commands[index] } } },
        { text: 'Child inspected.' },
        { text: 'Parent complete.' }
      )
      await f.engine.sessions.prompt({ sessionId, text: 'Run the native check.' })
    }
    assert.equal(outputFields(modelToolOutput(f, 'parent-bash-0')).session, 'first')
    assert.equal(outputFields(modelToolOutput(f, 'parent-bash-1')).session, 'missing')
  })

  contract(
    'forwards native stdout stderr and nonzero exit without changing the command',
    async (f) => {
      f.engine.host.register('environments.bindSession', () => ({
        ref: 'BoundExit',
        variables: { PATH: '/usr/bin:/bin', HOME: f.cwd }
      }))
      const observed = events(f)
      const approvals = approveTools(f)
      await f.engine.sessions.create(
        params(f, 'contract', {
          enableToolApproval: true,
          phiAgents: [boundSpecialist(f, 'BoundExit')]
        })
      )
      const command = 'printf "native-stdout\\n"; printf "native-stderr\\n" >&2; exit 7'
      f.provider.enqueue(
        { tool: { name: 'BoundExit', args: { task: 'Report the nonzero native command.' } } },
        { tool: { name: 'bash', id: 'native-exit', args: { command } } },
        { text: 'Exit observed.' },
        { text: 'Native exit reported.' }
      )
      const state = await f.engine.sessions.prompt({
        sessionId: 'contract',
        text: 'Run exit contract.'
      })
      assert.equal(text(state.messages!.at(-1)), 'Native exit reported.')
      const output = modelToolOutput(f, 'native-exit')
      assert.match(output, /native-stdout/)
      assert.match(output, /native-stderr/)
      assert.match(output, /(?:exit|code)[^\n]*7/i)
      assert.deepEqual(
        approvals
          .filter((item) => item.toolName === 'bash')
          .map((item) => record(item.input).command),
        [command]
      )
      const step = childSteps(observed).find(
        (item) => item.id === 'native-exit' && item.status === 'error'
      )
      assert.ok(step, 'Nonzero native exit must be forwarded as an error step')
    }
  )

  contract('cancels active native bound bash without delayed side effects', async (f) => {
    f.engine.host.register('environments.bindSession', () => ({
      ref: 'BoundCancel',
      variables: { PATH: '/usr/bin:/bin', HOME: f.cwd }
    }))
    const approvals = approveTools(f)
    const observed = events(f)
    await f.engine.sessions.create(
      params(f, 'contract', {
        enableToolApproval: true,
        phiAgents: [boundSpecialist(f, 'BoundCancel')]
      })
    )
    const started = join(f.cwd, 'native-started')
    const cancelled = join(f.cwd, 'native-should-not-write')
    const command = `printf started > ${shellLiteral(started)}; printf native-running; sleep 3; printf late > ${shellLiteral(cancelled)}`
    f.provider.enqueue(
      { tool: { name: 'BoundCancel', args: { task: 'Run until cancelled.' } } },
      { tool: { name: 'bash', id: 'native-cancel', args: { command } } }
    )
    const prompt = f.engine.sessions.prompt({
      sessionId: 'contract',
      text: 'Start native command.'
    })
    void prompt.catch(() => undefined)
    await until(() => existsSync(started), 'native bash started')
    await within(f.engine.sessions.abort({ sessionId: 'contract' }), 'abort native bash')
    const state = await within(prompt, 'cancelled native prompt')
    assert.ok(
      state.messages
        ?.map(record)
        .some((item) => item.role === 'assistant' && item.stopReason === 'aborted')
    )
    assert.ok(observed.some((item) => item.type === 'agent_end'))
    assert.deepEqual(
      approvals
        .filter((item) => item.toolName === 'bash')
        .map((item) => record(item.input).command),
      [command]
    )
    await new Promise((resolve) => setTimeout(resolve, 3200))
    assert.equal(existsSync(cancelled), false, 'Cancelled native command must not resume and write')
    f.provider.enqueue({ text: 'After native cancellation.' })
    const next = await f.engine.sessions.prompt({
      sessionId: 'contract',
      text: 'Continue after native cancellation.'
    })
    assert.equal(text(next.messages!.at(-1)), 'After native cancellation.')
  })

  contract('reads compaction defaults and applies and resets session overrides', async (f) => {
    const defaults = await f.engine.settings.autoCompactionDefaults({
      cwd: f.cwd,
      agentDir: f.agentDir
    })
    assert.equal(defaults.enabled, true)
    assert.equal(defaults.thresholdPercent, 80)
    await f.engine.sessions.create(params(f))
    const disabled = record(
      await f.engine.sessions.setAutoCompactionSettings({
        sessionId: 'contract',
        overrides: { enabled: false, thresholdPercent: 70 }
      })
    )
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.thresholdPercent, 70)
    const enabled = record(
      await f.engine.sessions.setAutoCompactionSettings({
        sessionId: 'contract',
        overrides: { enabled: true, thresholdPercent: 90 }
      })
    )
    assert.equal(enabled.enabled, true)
    assert.equal(enabled.thresholdPercent, 90)
    assert.equal(enabled.thresholdTokens, -1)
    const reset = await f.engine.sessions.setAutoCompactionSettings({
      sessionId: 'contract',
      overrides: {}
    })
    assert.deepEqual(reset, defaults)
    assert.deepEqual(
      await f.engine.settings.autoCompactionDefaults({ cwd: f.cwd, agentDir: f.agentDir }),
      defaults
    )
  })

  for (const [available, modelId] of [
    [true, 'contract-model'],
    [false, 'contract-model'],
    [false, 'contract[model]*']
  ] as const) {
    contract(
      `restores history when its saved model is ${available ? 'available' : 'unavailable'}${modelId.includes('[') ? ' (literal glob id)' : ''}`,
      async (f) => {
        const created = await f.engine.sessions.create(
          params(f, 'before', {
            noTools: 'all',
            sessionManager: { kind: 'persistent', cwd: f.cwd }
          })
        )
        f.provider.enqueue({ text: 'Saved evidence.' })
        const previous = await f.engine.sessions.prompt({
          sessionId: 'before',
          text: 'Remember this history.'
        })
        const path = previous.sessionFile ?? created.state.sessionFile
        assert.ok(path, 'Persistent session must return its history path')
        assert.ok(path.startsWith(f.agentDir), `History must be isolated: ${path}`)
        assert.equal(
          previous.model?.id,
          modelId,
          'The initial session must use this literal fixture ID'
        )
        await f.engine.stop()
        const selector = `${f.model.provider}/${modelId}`
        const saved = readFileSync(path, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => record(JSON.parse(line)))
        assert.ok(
          saved.some(
            (entry) =>
              (entry.type === 'model_change' && entry.model === selector) ||
              (entry.type === 'session_init' && entry.resolvedModel === selector)
          ),
          `History must persist the exact selector ${selector}`
        )
        if (!available) f.removeModel()
        const restored = await f.engine.sessions.create(
          params(f, 'restored', {
            noTools: 'all',
            sessionManager: { kind: 'open', cwd: f.cwd, path }
          })
        )
        assert.ok(restored.state.messages?.some((item) => text(item) === 'Saved evidence.'))
        if (available) {
          assert.equal(restored.state.model?.id, f.model.id)
          f.provider.enqueue({ text: 'Restored turn works.' })
          const state = await f.engine.sessions.prompt({ sessionId: 'restored', text: 'Resume.' })
          assert.equal(text(state.messages!.at(-1)), 'Restored turn works.')
          assert.ok(
            f.provider.requests
              .at(-1)
              ?.messages.some(
                (item) => item.role === 'assistant' && item.content === 'Saved evidence.'
              )
          )
        } else {
          assert.equal(
            restored.state.model,
            undefined,
            'Unavailable saved model must not silently fall back'
          )
          assert.equal(f.provider.requests.length, 1)
          await assert.rejects(
            f.engine.sessions.prompt({ sessionId: 'restored', text: 'Cannot send.' }),
            /model|available/i
          )
          const replacement = (
            await f.engine.models.snapshot({ agentDir: f.agentDir })
          ).models.find(
            (model) => model.provider === f.model.provider && model.id === f.replacementModel.id
          )
          assert.ok(replacement, 'Fixture replacement model must be available')
          const selected = await f.engine.sessions.setModel({
            sessionId: 'restored',
            agentDir: f.agentDir,
            model: replacement
          })
          assert.equal(selected.model?.id, replacement.id)
          f.provider.enqueue({ text: 'Recovered with replacement model.' })
          const resumed = await f.engine.sessions.prompt({
            sessionId: 'restored',
            text: 'Resume with valid model.'
          })
          assert.equal(text(resumed.messages!.at(-1)), 'Recovered with replacement model.')
          assert.equal(f.provider.requests.at(-1)?.model, replacement.id)
          assert.ok(resumed.messages?.some((item) => text(item) === 'Saved evidence.'))
        }
      },
      modelId
    )
  }

  contract('writes lists and deletes isolated API keys and exposes OAuth status', async (f) => {
    const before = await f.engine.models.snapshot({ agentDir: f.agentDir })
    assert.deepEqual(before.credentials, [])
    const oauthProvider = before.providers.find((item) => item.id === 'anthropic')
    assert.ok(oauthProvider?.auth?.oauth, 'Snapshot must expose OAuth capability')
    assert.equal(oauthProvider.status?.configured, false)
    const loggedIn = await f.engine.models.login({
      agentDir: f.agentDir,
      providerId: 'phi-contract',
      type: 'api_key',
      key: 'contract-disposable-secret'
    })
    assert.ok(
      loggedIn.credentials.some(
        (item) => item.providerId === 'phi-contract' && item.type === 'api_key'
      )
    )
    assert.ok(
      !JSON.stringify(loggedIn).includes('contract-disposable-secret'),
      'Snapshot must never expose the key'
    )
    await f.engine.stop()
    assert.ok(
      (await f.engine.models.snapshot({ agentDir: f.agentDir })).credentials.some(
        (item) => item.providerId === 'phi-contract'
      )
    )
    const loggedOut = await f.engine.models.logout({
      agentDir: f.agentDir,
      providerId: 'phi-contract'
    })
    assert.ok(!loggedOut.credentials.some((item) => item.providerId === 'phi-contract'))
    await f.engine.stop()
    assert.ok(
      !(await f.engine.models.snapshot({ agentDir: f.agentDir })).credentials.some(
        (item) => item.providerId === 'phi-contract'
      )
    )
    await assert.rejects(
      f.engine.models.login({
        agentDir: f.agentDir,
        providerId: 'phi-contract',
        type: 'oauth',
        key: undefined
      }),
      /oauth|provider|support/i
    )
    assert.equal(f.provider.requests.length, 0)
  })

  contract('reports stored OAuth state and persists its local deletion', async (f) => {
    await f.seedOAuth()
    const snapshot = await f.engine.models.snapshot({ agentDir: f.agentDir })
    assert.ok(
      snapshot.credentials.some(
        (item) =>
          item.providerId === 'anthropic' &&
          item.type === 'oauth' &&
          item.label === 'contract@example.invalid'
      )
    )
    const provider = snapshot.providers.find((item) => item.id === 'anthropic')
    assert.equal(provider?.status?.configured, true)
    assert.equal(provider?.status?.source, 'stored')
    assert.ok(!JSON.stringify(snapshot).includes('contract-oauth-access'))
    assert.ok(!JSON.stringify(snapshot).includes('contract-oauth-refresh'))
    await f.engine.stop()
    assert.ok(
      (await f.engine.models.snapshot({ agentDir: f.agentDir })).credentials.some(
        (item) => item.providerId === 'anthropic' && item.type === 'oauth'
      )
    )
    const deleted = await f.engine.models.logout({ agentDir: f.agentDir, providerId: 'anthropic' })
    assert.ok(!deleted.credentials.some((item) => item.providerId === 'anthropic'))
    assert.equal(
      deleted.providers.find((item) => item.id === 'anthropic')?.status?.configured,
      false
    )
    await f.engine.stop()
    const restarted = await f.engine.models.snapshot({ agentDir: f.agentDir })
    assert.ok(!restarted.credentials.some((item) => item.providerId === 'anthropic'))
    assert.equal(
      restarted.providers.find((item) => item.id === 'anthropic')?.status?.configured,
      false
    )
    assert.equal(f.provider.requests.length, 0)
  })
}
