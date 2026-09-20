import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  FAKE_NEXTFLOW,
  FAKE_NEXTFLOW_TREE,
  WRAPPER_ID,
  bundledEntry as entry,
  isAlive,
  waitFor,
  withSandbox
} from './helpers/wrapperSandbox'

import { runWrapperComposition } from '../src/main/agent/wrappers/composition/executor'
import {
  finishCompositionRun,
  markInterruptedCompositionRuns,
  startCompositionRun
} from '../src/main/agent/wrappers/composition/run-record'
import { buildWrapperReproducibilityBundle } from '../src/main/agent/wrappers/reproducibility'
import {
  listWrapperRuns,
  readWrapperRun,
  readWrapperRunEvents,
  writeWrapperRun
} from '../src/main/agent/wrappers/store'
import type { WrapperRun } from '../src/main/agent/wrappers/types'

// ── gap 1: cancelling must stop Nextflow ─────────────────────────────────

test('aborting a run kills the whole Nextflow process group and reports it cancelled', async () => {
  await withSandbox(async (sb) => {
    sb.useFake(FAKE_NEXTFLOW_TREE)
    const controller = new AbortController()
    const running = runWrapperComposition(entry().wrapperDir, { outdir: sb.outdir }, 'docker', {
      signal: controller.signal,
      killGraceMs: 500
    })
    await waitFor(() => existsSync(sb.pidFile) && existsSync(`${sb.pidFile}.child`))
    const parent = Number(readFileSync(sb.pidFile, 'utf8'))
    const grandchild = Number(readFileSync(`${sb.pidFile}.child`, 'utf8'))
    assert.ok(isAlive(parent) && isAlive(grandchild))

    const started = Date.now()
    controller.abort()
    const result = await running

    assert.equal(result.cancelled, true)
    assert.equal(result.success, false)
    assert.ok(Date.now() - started < 4000, 'cancel should not wait for the pipeline to finish')
    await waitFor(() => !isAlive(parent) && !isAlive(grandchild))
  })
})

test('an already-aborted signal never starts Nextflow', async () => {
  await withSandbox(async (sb) => {
    sb.useFake(FAKE_NEXTFLOW)
    const controller = new AbortController()
    controller.abort()
    const result = await runWrapperComposition(
      entry().wrapperDir,
      { outdir: sb.outdir },
      'docker',
      {
        signal: controller.signal
      }
    )
    assert.equal(result.cancelled, true)
    assert.equal(existsSync(sb.pidFile), false)
  })
})

test('a normal run without a signal still succeeds and is not marked cancelled', async () => {
  await withSandbox(async (sb) => {
    sb.useFake(FAKE_NEXTFLOW)
    const result = await runWrapperComposition(entry().wrapperDir, { outdir: sb.outdir }, 'docker')
    assert.equal(result.success, true)
    assert.equal(result.cancelled, undefined)
    assert.match(result.output, /\[SUCCESS\]/)
  })
})

// ── gap 2: runs are recorded ─────────────────────────────────────────────

test('starting a run records a running, agent-initiated composition run under the wrapper id', async () => {
  await withSandbox(async (sb) => {
    const run = startCompositionRun({
      entry: entry(),
      params: { gff: 'tests/data/genome.gff3', outdir: sb.outdir },
      profile: 'docker',
      agentDir: sb.agentDir
    })

    assert.match(run.runId, /^wrun_/)
    assert.equal(run.state, 'running')
    assert.equal(run.actor, 'agent')
    assert.equal(run.executor, 'local')
    assert.equal(run.origin, 'composition')
    assert.equal(run.profile, 'docker')
    assert.deepEqual(
      [run.wrapper.canonicalId, run.wrapper.namespace, run.wrapper.shortId],
      [WRAPPER_ID, 'nf-core/modules', 'gffread']
    )
    assert.equal(run.outDir, sb.outdir)
    assert.equal(run.cwd, entry().componentDir)
    assert.deepEqual(readWrapperRun(run.runId, sb.agentDir), run)
    assert.deepEqual(
      listWrapperRuns(sb.agentDir).map((r) => r.runId),
      [run.runId]
    )
  })
})

test('a relative outdir is recorded as an absolute path under the component directory', async () => {
  await withSandbox(async (sb) => {
    const run = startCompositionRun({
      entry: entry(),
      params: { gff: 'tests/data/genome.gff3', outdir: 'results' },
      profile: 'docker',
      agentDir: sb.agentDir
    })
    assert.equal(run.outDir, join(entry().componentDir, 'results'))
  })
})

test('finishing a run stores state, outputs, params, summary and an event trail', async () => {
  await withSandbox(async (sb) => {
    const params = { gff: 'tests/data/genome.gff3', outdir: sb.outdir }
    const started = startCompositionRun({
      entry: entry(),
      params,
      profile: 'docker',
      agentDir: sb.agentDir
    })
    mkdirSync(join(sb.outdir, 'gffread'), { recursive: true })
    writeFileSync(join(sb.outdir, 'gffread', 'out.gtf'), 'x')

    const done = finishCompositionRun({
      run: started,
      entry: entry(),
      params,
      outcome: 'completed',
      exitCode: 0,
      output: '[SUCCESS] completed=1',
      missingOutputs: [],
      agentDir: sb.agentDir
    })

    assert.equal(done.state, 'completed')
    assert.equal(done.exitCode, 0)
    assert.ok(done.completedAt)
    assert.deepEqual(
      done.outputs?.map((o) => [o.id, o.path, o.exists, o.primary, o.location]),
      [['annotation', join(sb.outdir, 'gffread'), true, true, 'local']]
    )
    assert.deepEqual(
      readWrapperRunEvents(started.runId, sb.agentDir).map((e) => [e.type, e.state]),
      [
        ['run_created', undefined],
        ['run_state_changed', 'completed']
      ]
    )

    const bundle = buildWrapperReproducibilityBundle(started.runId, sb.agentDir)
    assert.equal(bundle.run.runId, started.runId)
    assert.equal(bundle.plan, undefined)
    assert.deepEqual(bundle.params, params)
    assert.equal((bundle.summary as { success: boolean }).success, true)
    assert.match(JSON.stringify(bundle.summary), /SUCCESS/)
    assert.equal((bundle.outputs as Array<{ exists: boolean }>)[0].exists, true)
  })
})

test('failed and cancelled outcomes are recorded as such, with missing outputs flagged', async () => {
  await withSandbox(async (sb) => {
    const params = { gff: 'tests/data/genome.gff3', outdir: sb.outdir }
    const finish = (
      outcome: 'failed' | 'cancelled',
      exitCode: number,
      missing: string[]
    ): WrapperRun =>
      finishCompositionRun({
        run: startCompositionRun({
          entry: entry(),
          params,
          profile: 'docker',
          agentDir: sb.agentDir
        }),
        entry: entry(),
        params,
        outcome,
        exitCode,
        output: 'log',
        missingOutputs: missing,
        agentDir: sb.agentDir
      })

    const failed = finish('failed', 1, [])
    assert.equal(failed.state, 'failed')
    assert.equal(failed.exitCode, 1)

    const cancelled = finish('cancelled', -1, [])
    assert.equal(cancelled.state, 'cancelled')

    const missing = finish('failed', 0, ['annotation'])
    assert.equal(missing.state, 'failed')
    assert.equal(missing.outputs?.[0].exists, false)
  })
})

// ── startup reconciliation ───────────────────────────────────────────────

test('runs left running by a dead process are marked lost; finished and legacy runs are untouched', async () => {
  await withSandbox(async (sb) => {
    const params = { gff: 'tests/data/genome.gff3', outdir: sb.outdir }
    const stale = startCompositionRun({
      entry: entry(),
      params,
      profile: 'docker',
      agentDir: sb.agentDir
    })
    const finished = finishCompositionRun({
      run: startCompositionRun({
        entry: entry(),
        params,
        profile: 'docker',
        agentDir: sb.agentDir
      }),
      entry: entry(),
      params,
      outcome: 'completed',
      exitCode: 0,
      output: '',
      missingOutputs: [],
      agentDir: sb.agentDir
    })
    const legacy: WrapperRun = {
      ...stale,
      runId: 'wrun_legacy',
      origin: undefined,
      planId: 'wplan_x'
    }
    writeWrapperRun(legacy, sb.agentDir)

    assert.equal(markInterruptedCompositionRuns(sb.agentDir), 1)

    assert.equal(readWrapperRun(stale.runId, sb.agentDir)?.state, 'lost')
    assert.equal(readWrapperRun(finished.runId, sb.agentDir)?.state, 'completed')
    assert.equal(readWrapperRun('wrun_legacy', sb.agentDir)?.state, 'running')
    assert.equal(markInterruptedCompositionRuns(sb.agentDir), 0)
  })
})
