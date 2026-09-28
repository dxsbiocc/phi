import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { createHostJobClient } from '../src/main/agent/wrappers/composition/job-host-client'
import { wrapperJobHostHandlers } from '../src/main/agent/wrappers/composition/job-host-handlers'
import { WrapperJobManager } from '../src/main/agent/wrappers/composition/job-manager'
import {
  WRAPPER_JOB_HOST_METHODS,
  type WrapperJobStatus
} from '../src/main/agent/wrappers/composition/job-types'
import { buildWrapperCompositionTools } from '../src/main/agent/wrappers/composition/tools'
import {
  getWrapperRunsDir,
  listWrapperRuns,
  readWrapperRun
} from '../src/main/agent/wrappers/store'
import {
  FAKE_NEXTFLOW,
  WRAPPER_ID,
  isAlive,
  pidFileReady,
  waitFor,
  withSandbox,
  type Sandbox
} from './helpers/wrapperSandbox'

function manager(
  sb: Sandbox,
  options: ConstructorParameters<typeof WrapperJobManager>[0] = {}
): WrapperJobManager {
  return new WrapperJobManager({ agentDir: () => sb.agentDir, progressThrottleMs: 0, ...options })
}

async function startJob(
  m: WrapperJobManager,
  sb: Sandbox,
  overrides: Record<string, unknown> = {}
): Promise<WrapperJobStatus> {
  const result = await m.start({
    id: WRAPPER_ID,
    overrides: { outdir: sb.outdir, ...overrides },
    profile: 'docker'
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) throw new Error(result.error)
  return result.status
}

// ── the manager ───────────────────────────────────────────────────────────

test('start returns at once with a running job while Nextflow is still going', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    process.env.FAKE_NF_MS = '1500'
    const m = manager(sb)

    const began = Date.now()
    const status = await startJob(m, sb)
    assert.ok(Date.now() - began < 1000, 'start must not wait for the pipeline')

    assert.equal(status.state, 'running')
    assert.match(status.runId, /^wrun_/)
    assert.equal(status.wrapperId, WRAPPER_ID)
    assert.equal(status.profile, 'docker')
    assert.equal(readWrapperRun(status.runId, sb.agentDir)?.state, 'running')

    const done = await m.wait(status.runId, 20_000)
    assert.equal(done?.state, 'completed')
  })
})

test('status reports progress and the log tail while the run is in flight', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    process.env.FAKE_NF_MODE = 'hang'
    const m = manager(sb)
    const { runId } = await startJob(m, sb)

    await waitFor(() => (m.statusSync(runId)?.progress.started ?? 0) >= 1)
    const status = await m.status(runId)
    assert.equal(status?.state, 'running')
    assert.equal(status?.progress.started, 1)
    assert.equal(status?.progress.current, 'GFFREAD')
    assert.equal(status?.progress.total, 1)
    assert.match(status?.logTail ?? '', /\[PROCESS 87\/ef5c73\] GFFREAD/)

    // Persisted too, so the Wrappers view can show it without asking the manager.
    await waitFor(() => readWrapperRun(runId, sb.agentDir)?.progress?.started === 1)
    await m.cancel(runId)
    await m.wait(runId, 10_000)
  })
})

test('a finished run keeps its full log, outputs and final progress on disk', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = manager(sb)
    const { runId } = await startJob(m, sb)
    const done = await m.wait(runId, 20_000)

    assert.equal(done?.state, 'completed')
    assert.equal(done?.exitCode, 0)
    assert.equal(
      done?.outputs?.some((o) => o.primary && o.exists),
      true
    )
    assert.deepEqual(done?.missingOutputs, [])
    assert.match(
      readFileSync(join(getWrapperRunsDir(sb.agentDir), runId, 'nextflow.log'), 'utf8'),
      /\[SUCCESS\]/
    )
    assert.equal(readWrapperRun(runId, sb.agentDir)?.progress?.started, 1)

    // A brand-new manager (e.g. after a restart) answers from the store.
    const later = await manager(sb).status(runId)
    assert.equal(later?.state, 'completed')
    assert.match(later?.logTail ?? '', /\[SUCCESS\]/)
    assert.equal(later?.progress.started, 1)
  })
})

test('a failing run ends failed with its exit code and the error in the log', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    process.env.FAKE_NF_MODE = 'fail'
    const m = manager(sb)
    const { runId } = await startJob(m, sb)
    const done = await m.wait(runId, 20_000)

    assert.equal(done?.state, 'failed')
    assert.equal(done?.exitCode, 1)
    assert.match(done?.logTail ?? '', /boom/)
  })
})

test('cancel marks the run cancelling at once, then cancelled once Nextflow is really gone', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    process.env.FAKE_NF_MODE = 'hang'
    const m = manager(sb, { killGraceMs: 500 })
    const { runId } = await startJob(m, sb)
    await waitFor(() => pidFileReady(sb))
    const pid = Number(readFileSync(sb.pidFile, 'utf8'))

    const cancelled = await m.cancel(runId)
    assert.equal(cancelled.ok, true)
    assert.equal(readWrapperRun(runId, sb.agentDir)?.state, 'cancelling')

    const done = await m.wait(runId, 10_000)
    assert.equal(done?.state, 'cancelled')
    await waitFor(() => !isAlive(pid))
  })
})

test('cancelling an unknown or already finished run is refused', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = manager(sb)
    const { runId } = await startJob(m, sb)
    await m.wait(runId, 20_000)

    const finished = await m.cancel(runId)
    assert.equal(finished.ok, false)
    const unknown = await m.cancel('wrun_nope')
    assert.equal(unknown.ok, false)
  })
})

test('invalid parameters, an unknown wrapper or an unknown profile are rejected without recording a run', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = manager(sb)

    const badParams = await m.start({ id: WRAPPER_ID, overrides: { nope: 1 }, profile: 'docker' })
    assert.equal(badParams.ok, false)
    assert.match(badParams.ok ? '' : badParams.error, /Unknown parameter: nope/)

    const unknownWrapper = await m.start({
      id: 'nf-core/modules/does-not-exist',
      overrides: {},
      profile: 'docker'
    })
    assert.equal(unknownWrapper.ok, false)
    assert.match(unknownWrapper.ok ? '' : unknownWrapper.error, /not found/i)

    const badProfile = await m.start({ id: WRAPPER_ID, overrides: {}, profile: 'podman' })
    assert.equal(badProfile.ok, false)
    assert.match(badProfile.ok ? '' : badProfile.error, /profile/i)

    assert.deepEqual(listWrapperRuns(sb.agentDir), [])
  })
})

test('the number of concurrent jobs is limited', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    process.env.FAKE_NF_MODE = 'hang'
    const m = manager(sb, { maxConcurrent: 1, killGraceMs: 300 })
    const first = await startJob(m, sb)

    const second = await m.start({
      id: WRAPPER_ID,
      overrides: { outdir: sb.outdir },
      profile: 'docker'
    })
    assert.equal(second.ok, false)
    assert.match(second.ok ? '' : second.error, /already running|too many/i)
    assert.equal(listWrapperRuns(sb.agentDir).length, 1)

    await m.cancel(first.runId)
    await m.wait(first.runId, 10_000)
  })
})

test('wait returns the still-running status when the timeout passes first', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    process.env.FAKE_NF_MODE = 'hang'
    const m = manager(sb, { killGraceMs: 300 })
    const { runId } = await startJob(m, sb)

    const began = Date.now()
    const status = await m.wait(runId, 300)
    assert.equal(status?.state, 'running')
    assert.ok(Date.now() - began >= 250 && Date.now() - began < 3000)

    await m.cancel(runId)
    await m.wait(runId, 10_000)
    assert.equal(await m.wait('wrun_nope', 100), undefined)
  })
})

test('list returns runs newest first, live and stored', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = manager(sb)
    const a = await startJob(m, sb)
    await m.wait(a.runId, 20_000)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const b = await startJob(m, sb)
    await m.wait(b.runId, 20_000)

    const runs = await manager(sb).list()
    assert.deepEqual(
      runs.map((r) => r.runId),
      [b.runId, a.runId]
    )
    assert.equal(runs[0].wrapperId, WRAPPER_ID)
    assert.equal(runs[0].state, 'completed')
    assert.equal((await m.list(1)).length, 1)
  })
})

test('listeners hear about a run starting, progressing and ending', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = manager(sb)
    const heard: string[] = []
    const off = m.onChange((runId) => heard.push(runId))
    const { runId } = await startJob(m, sb)
    await m.wait(runId, 20_000)

    assert.ok(heard.length >= 2)
    assert.ok(heard.every((id) => id === runId))
    off()
    const before = heard.length
    await startJob(m, sb).then((s) => m.wait(s.runId, 20_000))
    assert.equal(heard.length, before)
  })
})

test('shutdown kills live jobs and records them cancelled immediately', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    process.env.FAKE_NF_MODE = 'hang'
    const m = manager(sb, { killGraceMs: 300 })
    const { runId } = await startJob(m, sb)
    await waitFor(() => pidFileReady(sb))
    const pid = Number(readFileSync(sb.pidFile, 'utf8'))

    m.shutdown()

    assert.equal(readWrapperRun(runId, sb.agentDir)?.state, 'cancelled')
    await waitFor(() => !isAlive(pid))
    assert.equal(existsSync(join(getWrapperRunsDir(sb.agentDir), runId, 'summary.json')), true)
  })
})

// ── the agent tools ───────────────────────────────────────────────────────

function toolsFor(
  m: WrapperJobManager
): Record<string, ReturnType<typeof buildWrapperCompositionTools>[number]> {
  return Object.fromEntries(buildWrapperCompositionTools(m).map((tool) => [tool.name, tool]))
}

function text(result: { content?: unknown }): string {
  return (result.content as Array<{ text: string }>).map((part) => part.text).join('')
}

test('the composition toolset is search, inspect, run, status, wait and cancel', async () => {
  await withSandbox(async (sb) => {
    assert.deepEqual(
      buildWrapperCompositionTools(manager(sb)).map((tool) => tool.name),
      [
        'wrapper_search',
        'wrapper_inspect',
        'wrapper_run',
        'wrapper_status',
        'wrapper_wait',
        'wrapper_cancel'
      ]
    )
  })
})

test('wrapper_run returns immediately with a run id and leaves the run in the background', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    process.env.FAKE_NF_MS = '1500'
    const m = manager(sb)
    const tools = toolsFor(m)

    const began = Date.now()
    const result = await tools.wrapper_run.execute('call', {
      id: WRAPPER_ID,
      params: { outdir: sb.outdir }
    })
    assert.ok(Date.now() - began < 1000)

    assert.equal(result.isError, undefined)
    const runId = (result.details as { runId: string }).runId
    assert.equal((result.details as { kind: string }).kind, 'wrapper_run_started')
    assert.match(text(result), new RegExp(runId))
    assert.match(text(result), /background/i)
    assert.equal(readWrapperRun(runId, sb.agentDir)?.state, 'running')

    await m.wait(runId, 20_000)
  })
})

test('wrapper_run reports rejected parameters as an error and starts nothing', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const tools = toolsFor(manager(sb))
    const result = await tools.wrapper_run.execute('call', {
      id: WRAPPER_ID,
      params: { read: 'x' }
    })
    assert.equal(result.isError, true)
    assert.match(text(result), /Unknown parameter: read/)
    assert.deepEqual(listWrapperRuns(sb.agentDir), [])

    const noId = await tools.wrapper_run.execute('call', {})
    assert.equal(noId.isError, true)
    const badProfile = await tools.wrapper_run.execute('call', {
      id: WRAPPER_ID,
      profile: 'podman'
    })
    assert.equal(badProfile.isError, true)
  })
})

test('wrapper_status describes a run, or lists recent runs without an id', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = manager(sb)
    const tools = toolsFor(m)
    const { runId } = await startJob(m, sb)
    await m.wait(runId, 20_000)

    const one = await tools.wrapper_status.execute('call', { run_id: runId })
    assert.equal(one.isError, undefined)
    assert.match(text(one), new RegExp(runId))
    assert.match(text(one), /completed/)
    assert.match(text(one), /Progress: 1 of 1/)
    assert.match(text(one), /gffread/)
    assert.match(text(one), new RegExp(sb.outdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    const list = await tools.wrapper_status.execute('call', {})
    assert.match(text(list), new RegExp(runId))
    assert.match(text(list), /nf-core\/modules\/gffread/)

    const missing = await tools.wrapper_status.execute('call', { run_id: 'wrun_nope' })
    assert.equal(missing.isError, true)
  })
})

test('wrapper_wait blocks until the run ends; on timeout it reports still running, not an error', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    process.env.FAKE_NF_MODE = 'hang'
    const m = manager(sb, { killGraceMs: 300 })
    const tools = toolsFor(m)
    const { runId } = await startJob(m, sb)

    const waiting = await tools.wrapper_wait.execute('call', { run_id: runId, timeout_seconds: 1 })
    assert.equal(waiting.isError, undefined)
    assert.match(text(waiting), /still running/i)

    await m.cancel(runId)
    const ended = await tools.wrapper_wait.execute('call', { run_id: runId, timeout_seconds: 10 })
    assert.match(text(ended), /cancelled/)
    assert.doesNotMatch(text(ended), /still running/i)

    const missing = await tools.wrapper_wait.execute('call', { run_id: 'wrun_nope' })
    assert.equal(missing.isError, true)
  })
})

test('wrapper_wait stops waiting when the tool call is aborted, without touching the run', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    process.env.FAKE_NF_MODE = 'hang'
    const m = manager(sb, { killGraceMs: 300 })
    const tools = toolsFor(m)
    const { runId } = await startJob(m, sb)

    const controller = new AbortController()
    const began = Date.now()
    const pending = tools.wrapper_wait.execute(
      'call',
      { run_id: runId, timeout_seconds: 60 },
      undefined,
      undefined as never,
      controller.signal
    )
    setTimeout(() => controller.abort(), 100)
    const result = await pending

    assert.ok(Date.now() - began < 3000)
    assert.match(text(result), /still running/i)
    assert.equal((await m.status(runId))?.state, 'running')
    await m.cancel(runId)
    await m.wait(runId, 10_000)
  })
})

test('wrapper_cancel stops a run; cancelling something that is not running is an error', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    process.env.FAKE_NF_MODE = 'hang'
    const m = manager(sb, { killGraceMs: 300 })
    const tools = toolsFor(m)
    const { runId } = await startJob(m, sb)

    const result = await tools.wrapper_cancel.execute('call', { run_id: runId })
    assert.equal(result.isError, undefined)
    assert.match(text(result), /cancel/i)
    assert.equal((await m.wait(runId, 10_000))?.state, 'cancelled')

    const again = await tools.wrapper_cancel.execute('call', { run_id: runId })
    assert.equal(again.isError, true)
  })
})

test('status, wait and cancel are read-only or write tiers as appropriate', async () => {
  await withSandbox(async (sb) => {
    const tools = toolsFor(manager(sb))
    assert.equal(tools.wrapper_run.approval, 'write')
    assert.equal(tools.wrapper_cancel.approval, 'write')
    assert.equal(tools.wrapper_status.approval, 'read')
    assert.equal(tools.wrapper_wait.approval, 'read')
  })
})

// ── across the process boundary ───────────────────────────────────────────

test('the host client forwards each call to its host method and returns the result unchanged', async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  const client = createHostJobClient(async (method, params) => {
    calls.push({ method, params })
    return { echoed: method }
  })

  await client.start({ id: 'a', overrides: { x: 1 }, profile: 'docker' })
  await client.status('r1')
  await client.list(3)
  await client.cancel('r1')
  const waited = await client.wait('r1', 5000)

  assert.deepEqual(
    calls.map((c) => c.method),
    [
      WRAPPER_JOB_HOST_METHODS.start,
      WRAPPER_JOB_HOST_METHODS.status,
      WRAPPER_JOB_HOST_METHODS.list,
      WRAPPER_JOB_HOST_METHODS.cancel,
      WRAPPER_JOB_HOST_METHODS.wait
    ]
  )
  assert.deepEqual(calls[0].params, { id: 'a', overrides: { x: 1 }, profile: 'docker' })
  assert.deepEqual(calls[1].params, { runId: 'r1' })
  assert.deepEqual(calls[2].params, { limit: 3 })
  assert.deepEqual(calls[4].params, { runId: 'r1', timeoutMs: 5000 })
  assert.deepEqual(waited, { echoed: WRAPPER_JOB_HOST_METHODS.wait })
})

test('host handlers validate what the worker sends and drive the manager end to end', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const handlers = wrapperJobHostHandlers(manager(sb))

    await assert.rejects(async () => handlers[WRAPPER_JOB_HOST_METHODS.start]({}), /id/)
    // `profile` is optional now (its default depends on where the run goes); `target: remote`
    // reaches the manager, which here has no remote support and says so.
    const refused = (await handlers[WRAPPER_JOB_HOST_METHODS.start]({
      id: WRAPPER_ID,
      target: 'remote'
    })) as { ok: boolean; error?: string }
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /[Rr]emote/)
    await assert.rejects(async () => handlers[WRAPPER_JOB_HOST_METHODS.status]('nope'), /runId/)

    const started = (await handlers[WRAPPER_JOB_HOST_METHODS.start]({
      id: WRAPPER_ID,
      overrides: { outdir: sb.outdir },
      profile: 'docker'
    })) as { ok: true; status: { runId: string } }
    assert.equal(started.ok, true)
    const { runId } = started.status

    const done = (await handlers[WRAPPER_JOB_HOST_METHODS.wait]({
      runId,
      timeoutMs: 20_000
    })) as { state: string }
    assert.equal(done.state, 'completed')

    const listed = (await handlers[WRAPPER_JOB_HOST_METHODS.list]({ limit: 5 })) as Array<{
      runId: string
    }>
    assert.deepEqual(
      listed.map((r) => r.runId),
      [runId]
    )
    // A junk timeout is clamped rather than trusted.
    const negative = (await handlers[WRAPPER_JOB_HOST_METHODS.wait]({ runId, timeoutMs: -5 })) as {
      state: string
    }
    assert.equal(negative.state, 'completed')
  })
})

// ── finish notifications ──────────────────────────────────────────────────

test('onFinish fires once when a run ends, with the run and its final status', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = manager(sb)
    const finished: Array<{ state: string; runId: string; origin?: string; elapsed: number }> = []
    m.onFinish((run, status) =>
      finished.push({
        state: run.state,
        runId: run.runId,
        origin: run.originSessionId,
        elapsed: status.elapsedSeconds
      })
    )

    const started = await m.start({
      id: WRAPPER_ID,
      overrides: { outdir: sb.outdir },
      profile: 'docker',
      originSessionId: 'runtime-42'
    })
    assert.equal(started.ok, true)
    const runId = started.ok ? started.status.runId : ''
    assert.deepEqual(finished, [])

    await m.wait(runId, 20_000)
    assert.equal(finished.length, 1)
    assert.equal(finished[0].state, 'completed')
    assert.equal(finished[0].runId, runId)
    assert.equal(finished[0].origin, 'runtime-42')
    assert.equal(readWrapperRun(runId, sb.agentDir)?.originSessionId, 'runtime-42')
  })
})

test('onFinish reports failed and cancelled runs too, and stays quiet for rejected starts', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = manager(sb, { killGraceMs: 300 })
    const states: string[] = []
    m.onFinish((run) => states.push(run.state))

    process.env.FAKE_NF_MODE = 'fail'
    await m.wait((await startJob(m, sb)).runId, 20_000)

    process.env.FAKE_NF_MODE = 'hang'
    const hung = await startJob(m, sb)
    await m.cancel(hung.runId)
    await m.wait(hung.runId, 10_000)

    await m.start({ id: WRAPPER_ID, overrides: { nope: 1 }, profile: 'docker' })
    assert.deepEqual(states, ['failed', 'cancelled'])
  })
})

test('a throwing finish listener never disturbs the run, and shutdown does not notify', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = manager(sb, { killGraceMs: 300 })
    let calls = 0
    m.onFinish(() => {
      calls += 1
      throw new Error('listener bug')
    })
    const { runId } = await startJob(m, sb)
    assert.equal((await m.wait(runId, 20_000))?.state, 'completed')
    assert.equal(calls, 1)

    process.env.FAKE_NF_MODE = 'hang'
    await startJob(m, sb)
    m.shutdown()
    assert.equal(calls, 1)
  })
})

test('the host client stamps every start with the runtime session that owns the tools', async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  const client = createHostJobClient(
    async (method, params) => {
      calls.push({ method, params })
      return { ok: false, error: 'x' }
    },
    { originSessionId: 'runtime-7' }
  )
  await client.start({ id: 'a', overrides: {}, profile: 'docker' })
  assert.deepEqual(calls[0].params, {
    id: 'a',
    overrides: {},
    profile: 'docker',
    originSessionId: 'runtime-7'
  })
})

test('host handlers pass the origin session through and ignore a non-string one', async () => {
  const seen: unknown[] = []
  const handlers = wrapperJobHostHandlers({
    start: async (input) => {
      seen.push(input)
      return { ok: false, error: 'stub' }
    }
  } as never)
  const start = handlers[WRAPPER_JOB_HOST_METHODS.start]
  await start({ id: 'a', overrides: {}, profile: 'docker', originSessionId: 'runtime-7' })
  await start({ id: 'a', overrides: {}, profile: 'docker', originSessionId: 7 })
  assert.deepEqual(seen, [
    { id: 'a', overrides: {}, profile: 'docker', originSessionId: 'runtime-7' },
    { id: 'a', overrides: {}, profile: 'docker' }
  ])
})

// ── continue when done ────────────────────────────────────────────────────

test('continue_when_done is stored on the run: default yes, and an explicit no is kept', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = manager(sb)
    const start = async (extra: Record<string, unknown>): Promise<string> => {
      const result = await m.start({
        id: WRAPPER_ID,
        overrides: { outdir: sb.outdir },
        profile: 'docker',
        ...extra
      })
      assert.equal(result.ok, true)
      const runId = result.ok ? result.status.runId : ''
      await m.wait(runId, 20_000)
      return runId
    }

    assert.equal(readWrapperRun(await start({}), sb.agentDir)?.continueWhenDone, undefined)
    assert.equal(
      readWrapperRun(await start({ continueWhenDone: false }), sb.agentDir)?.continueWhenDone,
      false
    )
  })
})

test('wrapper_run passes continue_when_done to the job client; anything but false means yes', async () => {
  const seen: unknown[] = []
  const client = {
    start: async (input: unknown) => {
      seen.push(input)
      return { ok: false as const, error: 'stub' }
    }
  }
  const tool = buildWrapperCompositionTools(client as never).find((t) => t.name === 'wrapper_run')!
  await tool.execute('c', { id: WRAPPER_ID, continue_when_done: false })
  await tool.execute('c', { id: WRAPPER_ID })
  await tool.execute('c', { id: WRAPPER_ID, continue_when_done: 'no' })
  assert.deepEqual(
    seen.map((s) => (s as { continueWhenDone?: boolean }).continueWhenDone),
    [false, undefined, undefined]
  )
})

test('wrapper_run forwards explicit local and remote targets without silently dropping local', async () => {
  const seen: unknown[] = []
  const client = {
    start: async (input: unknown) => {
      seen.push(input)
      return { ok: false as const, error: 'stub' }
    }
  }
  const tool = buildWrapperCompositionTools(client as never).find(
    (entry) => entry.name === 'wrapper_run'
  )!
  await tool.execute('local', { id: WRAPPER_ID, target: 'local' })
  await tool.execute('remote', { id: WRAPPER_ID, target: 'remote' })
  await tool.execute('auto', { id: WRAPPER_ID })
  assert.deepEqual(
    seen.map((input) => (input as { target?: string }).target),
    ['local', 'remote', undefined]
  )
})

test('the host client and handlers carry continueWhenDone across the process boundary', async () => {
  const calls: unknown[] = []
  const client = createHostJobClient(async (_m, params) => {
    calls.push(params)
    return { ok: false, error: 'x' }
  })
  await client.start({ id: 'a', overrides: {}, profile: 'docker', continueWhenDone: false })
  assert.equal((calls[0] as { continueWhenDone?: boolean }).continueWhenDone, false)

  const seen: unknown[] = []
  const handlers = wrapperJobHostHandlers({
    start: async (input: unknown) => {
      seen.push(input)
      return { ok: false, error: 'stub' }
    }
  } as never)
  const start = handlers[WRAPPER_JOB_HOST_METHODS.start]
  await start({ id: 'a', overrides: {}, profile: 'docker', continueWhenDone: false })
  await start({ id: 'a', overrides: {}, profile: 'docker', continueWhenDone: 'nope' })
  assert.deepEqual(
    seen.map((s) => (s as { continueWhenDone?: boolean }).continueWhenDone),
    [false, undefined]
  )
})

// ── results already handed to an agent ────────────────────────────────────

test('an outcome counts as reported once wait or status has handed it to an agent', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = manager(sb)

    const viaWait = (await startJob(m, sb)).runId
    assert.equal(m.hasBeenReported(viaWait), false)
    await m.wait(viaWait, 20_000)
    assert.equal(m.hasBeenReported(viaWait), true)

    const viaStatus = await startJob(m, sb)
    await waitFor(() => readWrapperRun(viaStatus.runId, sb.agentDir)?.state === 'completed')
    assert.equal(m.hasBeenReported(viaStatus.runId), false, 'finishing alone is not reporting')
    await m.status(viaStatus.runId)
    assert.equal(m.hasBeenReported(viaStatus.runId), true)
  })
})

test('looking at a run that is still going does not mark it reported', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    process.env.FAKE_NF_MODE = 'hang'
    const m = manager(sb, { killGraceMs: 300 })
    const { runId } = await startJob(m, sb)

    await m.status(runId)
    await m.wait(runId, 200)
    assert.equal(m.hasBeenReported(runId), false)

    await m.cancel(runId)
    await m.wait(runId, 10_000)
    assert.equal(m.hasBeenReported(runId), true)
  })
})

test('wrapper_run tells the agent whether the conversation will be woken when the run ends', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    process.env.FAKE_NF_MS = '50'
    const m = manager(sb)
    const run = buildWrapperCompositionTools(m).find((t) => t.name === 'wrapper_run')!

    const woken = await run.execute('c', { id: WRAPPER_ID, params: { outdir: sb.outdir } })
    assert.match(text(woken), /wakes the main agent/i)
    assert.match(text(woken), /do not need to wait/i)

    const quiet = await run.execute('c', {
      id: WRAPPER_ID,
      params: { outdir: sb.outdir },
      continue_when_done: false
    })
    assert.match(text(quiet), /will NOT be woken/)
    for (const r of [woken, quiet]) await m.wait((r.details as { runId: string }).runId, 20_000)
  })
})

// ── per-run resources ─────────────────────────────────────────────────────

/** The stand-in nextflow, also recording its argv, the -c config it got and its env. */
const RECORDING_NEXTFLOW = FAKE_NEXTFLOW.replace(
  'const args = process.argv.slice(2)\n',
  'const args = process.argv.slice(2)\n' +
    "const ci = args.indexOf('-c')\n" +
    "fs.writeFileSync(process.env.FAKE_NF_RECORD, JSON.stringify({ args, config: ci >= 0 ? fs.readFileSync(args[ci + 1], 'utf8') : null, noVersionCheck: process.env.NXF_DISABLE_CHECK_LATEST }))\n"
)

test('wrapper_run resources reach Nextflow as a run config and are kept on the run record', async () => {
  await withSandbox(async (sb) => {
    sb.useFake(RECORDING_NEXTFLOW)
    const recordPath = join(sb.root, 'nextflow-call.json')
    process.env.FAKE_NF_RECORD = recordPath
    try {
      const m = manager(sb)
      const handlers = wrapperJobHostHandlers(m)
      const client = createHostJobClient((method, params) => handlers[method](params))
      const run = Object.fromEntries(
        buildWrapperCompositionTools(client).map((tool) => [tool.name, tool])
      ).wrapper_run

      const result = await run.execute('call-1', {
        id: WRAPPER_ID,
        params: { outdir: sb.outdir },
        profile: 'docker',
        resources: { cpus: 8, memory: '40G', time: '4h' }
      })
      assert.equal((result as { isError?: boolean }).isError, undefined, text(result))
      const runId = (result as { details: { runId: string } }).details.runId
      assert.equal((await m.wait(runId, 20_000))?.state, 'completed')

      const call = JSON.parse(readFileSync(recordPath, 'utf-8')) as {
        args: string[]
        config: string | null
        noVersionCheck?: string
      }
      assert.ok(call.args.includes('-c'))
      assert.match(call.config ?? '', /withName: '\.\*'/)
      assert.match(call.config ?? '', /cpus = 8/)
      assert.match(call.config ?? '', /memory = '40 GB'/)
      assert.match(call.config ?? '', /time = '4h'/)
      assert.equal(call.noVersionCheck, 'true')
      assert.deepEqual(readWrapperRun(runId, sb.agentDir)?.resources, {
        cpus: 8,
        memory: '40 GB',
        time: '4h'
      })
    } finally {
      delete process.env.FAKE_NF_RECORD
    }
  })
})

test('a run without resources passes no extra config, and invalid resources start nothing', async () => {
  await withSandbox(async (sb) => {
    sb.useFake(RECORDING_NEXTFLOW)
    const recordPath = join(sb.root, 'nextflow-call.json')
    process.env.FAKE_NF_RECORD = recordPath
    try {
      const m = manager(sb)
      const { runId } = await startJob(m, sb)
      assert.equal((await m.wait(runId, 20_000))?.state, 'completed')
      const call = JSON.parse(readFileSync(recordPath, 'utf-8')) as { args: string[] }
      assert.equal(call.args.includes('-c'), false)
      assert.equal(readWrapperRun(runId, sb.agentDir)?.resources, undefined)

      const before = listWrapperRuns(sb.agentDir).length
      const refused = await m.start({
        id: WRAPPER_ID,
        overrides: { outdir: sb.outdir },
        profile: 'docker',
        resources: { memory: '40' }
      })
      assert.equal(refused.ok, false)
      assert.match(refused.ok ? '' : refused.error, /memory/)
      assert.equal(listWrapperRuns(sb.agentDir).length, before)
    } finally {
      delete process.env.FAKE_NF_RECORD
    }
  })
})
