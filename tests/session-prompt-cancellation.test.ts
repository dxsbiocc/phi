import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const testFile = fileURLToPath(import.meta.url)
const MARKER = 'phi-prompt-cancellation:ok'

type Scenario =
  | 'abort'
  | 'fallback'
  | 'fallback-switch'
  | 'reentry'
  | 'dispose'
  | 'isolation'
  | 'overlap'
  | 'install-failure'

type FakeBash = {
  name: string
  execute(toolCallId: string, args: unknown, signal?: AbortSignal): Promise<{ content: never[] }>
}

function fakeBash(
  signals: Array<AbortSignal | undefined>,
  started: () => void,
  waitForRelease: Promise<void>
): FakeBash {
  return {
    name: 'bash',
    async execute(_toolCallId, _args, signal) {
      signals.push(signal)
      if (signals.length === 1) {
        started()
        await waitForRelease
      }
      return { content: [] }
    }
  }
}

function fakeSession(
  bash: FakeBash,
  state: { prompts: number; aborts: number; disposes: number },
  options: { prompt?: () => Promise<void>; model?: Record<string, unknown> } = {}
): Record<string, unknown> {
  const session: Record<string, unknown> = {
    sessionFile: undefined,
    messages: [] as unknown[],
    thinkingLevel: 'high',
    model: options.model ?? {
      provider: 'fixture',
      id: 'fixture',
      name: 'fixture',
      input: ['text']
    },
    sessionManager: { getCwd: () => '/tmp' },
    getToolByName: (name: string) => (name === 'bash' ? bash : undefined),
    getAllToolInfos: () => [],
    prompt: async () => {
      state.prompts += 1
      if (options.prompt) return await options.prompt()
      await bash.execute(`call-${state.prompts}`, {}, undefined)
    },
    abort: async () => {
      state.aborts += 1
    },
    dispose: async () => {
      state.disposes += 1
    }
  }
  return session
}

async function runScenario(scenario: Scenario): Promise<void> {
  const { promptSession, abortSession, disposeSession } =
    await import('../src/main/agent/engine/in-process/session-runtime')
  const { sessions } = await import('../src/main/agent/engine/in-process/state')
  const { setWorkerOutbound } = await import('../src/main/agent/engine/in-process/ipc')
  setWorkerOutbound({
    send: () => undefined,
    event: () => undefined,
    hostRequest: async () => undefined
  } as never)

  if (scenario === 'abort') {
    const signals: Array<AbortSignal | undefined> = []
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const waiting = new Promise<void>((resolve) => {
      started = resolve
    })
    const state = { prompts: 0, aborts: 0, disposes: 0 }
    const session = fakeSession(fakeBash(signals, started, released), state)
    sessions.set('cancel-abort', { result: { session }, agentDir: '/tmp' } as never)
    try {
      const running = promptSession({ sessionId: 'cancel-abort', text: 'first' })
      await waiting
      const firstSignal = signals[0]
      assert.ok(firstSignal, 'prompt scope reaches the native tool')
      assert.equal(firstSignal.aborted, false)
      await abortSession({ sessionId: 'cancel-abort' })
      assert.equal(state.aborts, 1, 'SDK abort still runs')
      assert.equal(firstSignal.aborted, true, 'abort cancels the prompt scope')
      await assert.rejects(
        promptSession({ sessionId: 'cancel-abort', text: 'too early' }),
        /already processing/,
        'a new prompt waits for the aborted prompt to settle'
      )
      assert.equal(state.prompts, 1)
      release()
      await running
      await promptSession({ sessionId: 'cancel-abort', text: 'second' })
      assert.equal(state.prompts, 2)
      const nextSignal = signals[1]
      assert.ok(nextSignal, 'next prompt gets a new owner signal')
      assert.notEqual(nextSignal, firstSignal)
      assert.equal(nextSignal.aborted, false, 'next prompt is not born aborted')
    } finally {
      sessions.delete('cancel-abort')
    }
    return
  }

  if (scenario === 'fallback') {
    let release!: (models: unknown[]) => void
    let reached!: () => void
    const waiting = new Promise<void>((resolve) => {
      reached = resolve
    })
    const candidates = new Promise<unknown[]>((resolve) => {
      release = resolve
    })
    const state = { prompts: 0, aborts: 0, disposes: 0 }
    let switches = 0
    const first = { provider: 'fixture', id: 'first', name: 'first', input: ['text'] }
    const session = fakeSession({ name: 'bash', execute: async () => ({ content: [] }) }, state, {
      model: first,
      prompt: async () => {
        throw new Error('provider unavailable 503')
      }
    })
    session.setModel = async (model: unknown) => {
      switches += 1
      session.model = model
    }
    sessions.set('cancel-fallback', {
      result: { session },
      agentDir: '/tmp',
      context: {
        modelRegistry: {
          getAvailable: () => {
            reached()
            return candidates
          }
        }
      }
    } as never)
    try {
      const running = promptSession({
        sessionId: 'cancel-fallback',
        text: 'fixture',
        options: { modelSelection: 'automatic' }
      })
      await waiting
      await abortSession({ sessionId: 'cancel-fallback' })
      release([{ provider: 'fixture', id: 'second', name: 'second', input: ['text'] }])
      await running
      assert.equal(state.prompts, 1, 'stop prevents a fallback prompt')
      assert.equal(switches, 0, 'stop prevents a fallback model switch')
    } finally {
      sessions.delete('cancel-fallback')
    }
    return
  }

  if (scenario === 'fallback-switch') {
    const state = { prompts: 0, aborts: 0, disposes: 0 }
    let switches = 0
    const session = fakeSession({ name: 'bash', execute: async () => ({ content: [] }) }, state, {
      model: { provider: 'fixture', id: 'first', name: 'first', input: ['text'] },
      prompt: async () => {
        if (state.prompts === 1) throw new Error('provider unavailable 503')
      }
    })
    session.setModel = async (model: unknown) => {
      switches += 1
      session.model = model
    }
    sessions.set('cancel-switch', {
      result: { session },
      agentDir: '/tmp',
      context: {
        modelRegistry: {
          getAvailable: async () => [
            { provider: 'fixture', id: 'second', name: 'second', input: ['text'] }
          ]
        }
      }
    } as never)
    try {
      await promptSession({
        sessionId: 'cancel-switch',
        text: 'fixture',
        options: { modelSelection: 'automatic' }
      })
      assert.equal(state.prompts, 2, 'a live fallback still prompts the next model')
      assert.equal(switches, 1, 'a live fallback still switches models')
    } finally {
      sessions.delete('cancel-switch')
    }
    return
  }

  if (scenario === 'reentry') {
    let release!: (models: unknown[]) => void
    let reached!: () => void
    const waiting = new Promise<void>((resolve) => {
      reached = resolve
    })
    const candidates = new Promise<unknown[]>((resolve) => {
      release = resolve
    })
    const state = { prompts: 0, aborts: 0, disposes: 0 }
    let switches = 0
    const session = fakeSession({ name: 'bash', execute: async () => ({ content: [] }) }, state, {
      model: { provider: 'fixture', id: 'first', name: 'first', input: ['text'] },
      prompt: async () => {
        if (state.prompts === 1) throw new Error('provider unavailable 503')
      }
    })
    session.setModel = async (model: unknown) => {
      switches += 1
      session.model = model
    }
    sessions.set('cancel-reentry', {
      result: { session },
      agentDir: '/tmp',
      context: {
        modelRegistry: {
          getAvailable: () => {
            reached()
            return candidates
          }
        }
      }
    } as never)
    try {
      const stopped = promptSession({
        sessionId: 'cancel-reentry',
        text: 'fixture',
        options: { modelSelection: 'automatic' }
      })
      await waiting
      await abortSession({ sessionId: 'cancel-reentry' })
      await assert.rejects(
        promptSession({ sessionId: 'cancel-reentry', text: 'newer' }),
        /already processing/,
        'a newer prompt waits for the stopped fallback to settle'
      )
      release([{ provider: 'fixture', id: 'second', name: 'second', input: ['text'] }])
      await stopped
      assert.equal(state.prompts, 1, 'stopped fallback never prompts another model')
      assert.equal(switches, 0, 'stopped fallback never switches models')
      await promptSession({ sessionId: 'cancel-reentry', text: 'newer' })
      assert.equal(state.prompts, 2, 'a prompt admitted after settlement runs normally')
      assert.equal(switches, 0)
    } finally {
      sessions.delete('cancel-reentry')
    }
    return
  }

  if (scenario === 'dispose') {
    const signals: Array<AbortSignal | undefined> = []
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const waiting = new Promise<void>((resolve) => {
      started = resolve
    })
    const state = { prompts: 0, aborts: 0, disposes: 0 }
    const session = fakeSession(fakeBash(signals, started, released), state)
    sessions.set('cancel-dispose', { result: { session }, agentDir: '/tmp' } as never)
    try {
      const running = promptSession({ sessionId: 'cancel-dispose', text: 'first' })
      await waiting
      await disposeSession({ sessionId: 'cancel-dispose' })
      assert.equal(state.disposes, 1, 'SDK dispose still runs')
      assert.equal(signals[0]?.aborted, true, 'dispose cancels the active prompt scope')
      assert.equal(sessions.has('cancel-dispose'), false)
      release()
      await running.catch(() => undefined)
    } finally {
      sessions.delete('cancel-dispose')
    }
    return
  }

  if (scenario === 'install-failure') {
    let lookups = 0
    let seen: AbortSignal | undefined
    const state = { prompts: 0, aborts: 0, disposes: 0 }
    const bash = {
      name: 'bash',
      async execute(_id: string, _args: unknown, signal?: AbortSignal) {
        seen = signal
        return { content: [] }
      }
    }
    const session = fakeSession(bash, state)
    session.getToolByName = (name: string) => {
      if (++lookups === 1) throw new Error('fixture installation failed')
      return name === 'bash' ? bash : undefined
    }
    sessions.set('cancel-install', { result: { session }, agentDir: '/tmp' } as never)
    try {
      await assert.rejects(
        promptSession({
          sessionId: 'cancel-install',
          text: 'first',
          options: { hostRunId: 'run-a' }
        }),
        /installation failed/
      )
      assert.equal(
        sessions.get('cancel-install')?.activePromptAbort,
        undefined,
        'failed scope installation releases the controller'
      )
      assert.equal(
        sessions.get('cancel-install')?.activeHostRunId,
        undefined,
        'failed scope installation releases the run binding'
      )
      await promptSession({
        sessionId: 'cancel-install',
        text: 'second',
        options: { hostRunId: 'run-b' }
      })
      assert.ok(seen, 'next prompt installs a working owner signal')
      assert.equal(seen?.aborted, false)
    } finally {
      sessions.delete('cancel-install')
    }
    return
  }

  if (scenario === 'overlap') {
    const signals: Array<AbortSignal | undefined> = []
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const waiting = new Promise<void>((resolve) => {
      started = resolve
    })
    const state = { prompts: 0, aborts: 0, disposes: 0 }
    let active = false
    const bash = fakeBash(signals, started, released)
    const session = fakeSession(bash, state, {
      prompt: async () => {
        if (active) throw new Error('Agent is already processing')
        active = true
        try {
          await bash.execute('call', {}, undefined)
        } finally {
          active = false
        }
      }
    })
    sessions.set('cancel-overlap', { result: { session }, agentDir: '/tmp' } as never)
    try {
      const running = promptSession({
        sessionId: 'cancel-overlap',
        text: 'first',
        options: { hostRunId: 'run-a' }
      })
      await waiting
      await assert.rejects(
        promptSession({
          sessionId: 'cancel-overlap',
          text: 'second',
          options: { hostRunId: 'run-b' }
        }),
        /already processing/
      )
      assert.equal(
        sessions.get('cancel-overlap')?.activeHostRunId,
        'run-a',
        'rejected overlap keeps the admitted run binding'
      )
      assert.equal(signals.length, 1, 'rejected overlap installs no second native scope')
      assert.equal(state.prompts, 1, 'rejected overlap never reaches the prompt')
      await abortSession({ sessionId: 'cancel-overlap' })
      assert.equal(signals[0]?.aborted, true, 'rejected overlap keeps the active scope')
      release()
      await running
    } finally {
      sessions.delete('cancel-overlap')
    }
    return
  }

  const firstSignals: Array<AbortSignal | undefined> = []
  const secondSignals: Array<AbortSignal | undefined> = []
  let releaseFirst!: () => void
  let releaseSecond!: () => void
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const secondReleased = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  let firstStarted!: () => void
  let secondStarted!: () => void
  const firstWaiting = new Promise<void>((resolve) => {
    firstStarted = resolve
  })
  const secondWaiting = new Promise<void>((resolve) => {
    secondStarted = resolve
  })
  const firstState = { prompts: 0, aborts: 0, disposes: 0 }
  const secondState = { prompts: 0, aborts: 0, disposes: 0 }
  sessions.set('cancel-isolation-a', {
    result: {
      session: fakeSession(fakeBash(firstSignals, firstStarted, firstReleased), firstState)
    },
    agentDir: '/tmp'
  } as never)
  sessions.set('cancel-isolation-b', {
    result: {
      session: fakeSession(fakeBash(secondSignals, secondStarted, secondReleased), secondState)
    },
    agentDir: '/tmp'
  } as never)
  try {
    const runningFirst = promptSession({ sessionId: 'cancel-isolation-a', text: 'first' })
    const runningSecond = promptSession({ sessionId: 'cancel-isolation-b', text: 'second' })
    await Promise.all([firstWaiting, secondWaiting])
    await abortSession({ sessionId: 'cancel-isolation-a' })
    assert.equal(firstSignals[0]?.aborted, true, 'stopped session scope is aborted')
    assert.equal(secondSignals[0]?.aborted, false, 'other session scope is untouched')
    assert.equal(firstState.aborts, 1)
    assert.equal(secondState.aborts, 0)
    releaseFirst()
    releaseSecond()
    await Promise.all([runningFirst, runningSecond])
  } finally {
    sessions.delete('cancel-isolation-a')
    sessions.delete('cancel-isolation-b')
  }
}

if (process.env.PHI_PROMPT_CANCEL_SCENARIO) {
  await runScenario(process.env.PHI_PROMPT_CANCEL_SCENARIO as Scenario)
  console.log(MARKER)
  process.exit(0)
}

for (const scenario of [
  'abort',
  'fallback',
  'fallback-switch',
  'reentry',
  'dispose',
  'isolation',
  'overlap',
  'install-failure'
] as const) {
  test(`ordinary prompt cancellation: ${scenario}`, async () => {
    // The in-process runtime imports Bun-only modules, so the scenario runs in a Bun child.
    const home = await mkdtemp(join(tmpdir(), 'phi-prompt-cancel-'))
    try {
      const result = await execFileAsync('bun', [testFile], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: process.env.TMPDIR,
          PI_CODING_AGENT_DIR: home,
          PHI_PROMPT_CANCEL_SCENARIO: scenario
        },
        timeout: 60_000,
        maxBuffer: 1024 * 1024
      })
      assert.match(result.stdout, new RegExp(MARKER))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
}
