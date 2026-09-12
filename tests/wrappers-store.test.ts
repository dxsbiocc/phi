import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { redactSecretsDeep } from '../src/main/agent/wrappers/audit'
import {
  appendWrapperAuditEvent,
  appendWrapperRunEvent,
  ensureWrapperStorageDirs,
  getInstalledWrappersDir,
  getWrapperPlansDir,
  getWrapperRunsDir,
  getWrappersRootDir,
  listWrapperPlans,
  listWrapperRuns,
  readGlobalWrapperAuditEvents,
  readWrapperPlan,
  readWrapperRun,
  readWrapperRunEvents,
  writeWrapperPlan,
  writeWrapperRun
} from '../src/main/agent/wrappers/store'
import type { WrapperRun, WrapperRunPlan } from '../src/main/agent/wrappers/types'

function withPhiDir<T>(callback: (agentDir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrappers-'))
  const agentDir = join(root, '.phi-home')
  try {
    return callback(agentDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function samplePlan(overrides: Partial<WrapperRunPlan> = {}): WrapperRunPlan {
  const now = new Date().toISOString()
  return {
    planId: 'wplan_test1',
    revision: 1,
    state: 'draft',
    actor: 'agent',
    wrapper: {
      canonicalId: 'phi/ngs/fastq-qc',
      namespace: 'phi/ngs',
      shortId: 'fastq-qc',
      version: '1.0.0'
    },
    wrapperName: 'FASTQ QC',
    trustTier: 'bundled',
    executor: 'local',
    profile: 'local',
    resourceClass: 'light',
    params: { reads: 'data/*_{R1,R2}.fastq.gz' },
    inputs: [],
    outputDir: 'results/phi-wrapper/fastq-qc/run',
    resources: { cpus: 4, memory: '8 GB' },
    commandPlan: { command: 'nextflow run wrapper/main.nf -profile local', profile: 'local' },
    validation: { valid: true, errors: [] },
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

function sampleRun(overrides: Partial<WrapperRun> = {}): WrapperRun {
  const now = new Date().toISOString()
  return {
    runId: 'wrun_test1',
    planId: 'wplan_test1',
    revision: 1,
    state: 'created',
    actor: 'agent',
    wrapper: {
      canonicalId: 'phi/ngs/fastq-qc',
      namespace: 'phi/ngs',
      shortId: 'fastq-qc',
      version: '1.0.0'
    },
    trustTier: 'bundled',
    executor: 'local',
    profile: 'local',
    outDir: 'results/phi-wrapper/fastq-qc/run',
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

test('ensureWrapperStorageDirs creates installed/plans/runs under the agent dir', () => {
  withPhiDir((agentDir) => {
    ensureWrapperStorageDirs(agentDir)
    assert.ok(existsSync(getInstalledWrappersDir(agentDir)))
    assert.ok(existsSync(getWrapperPlansDir(agentDir)))
    assert.ok(existsSync(getWrapperRunsDir(agentDir)))
  })
})

test('writeWrapperPlan/readWrapperPlan round-trip and list all plans', () => {
  withPhiDir((agentDir) => {
    const plan = samplePlan()
    writeWrapperPlan(plan, agentDir)

    const loaded = readWrapperPlan(plan.planId, agentDir)
    assert.deepEqual(loaded, plan)
    assert.deepEqual(
      listWrapperPlans(agentDir).map((item) => item.planId),
      [plan.planId]
    )
  })
})

test('writeWrapperRun/readWrapperRun round-trip and list all runs', () => {
  withPhiDir((agentDir) => {
    const run = sampleRun()
    writeWrapperRun(run, agentDir)

    const loaded = readWrapperRun(run.runId, agentDir)
    assert.deepEqual(loaded, run)
    assert.deepEqual(
      listWrapperRuns(agentDir).map((item) => item.runId),
      [run.runId]
    )
  })
})

test('appendWrapperRunEvent appends JSON lines without rewriting previous entries', () => {
  withPhiDir((agentDir) => {
    const run = sampleRun()
    writeWrapperRun(run, agentDir)

    appendWrapperRunEvent(
      run.runId,
      { type: 'run_created', timestamp: new Date().toISOString() },
      agentDir
    )
    appendWrapperRunEvent(
      run.runId,
      { type: 'run_state_changed', timestamp: new Date().toISOString(), state: 'running' },
      agentDir
    )

    const events = readWrapperRunEvents(run.runId, agentDir)
    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'run_created')
    assert.equal(events[1].type, 'run_state_changed')
    assert.equal(events[1].state, 'running')
  })
})

test('appendWrapperAuditEvent redacts secret-shaped fields in both the global and run-scoped log', () => {
  withPhiDir((agentDir) => {
    const run = sampleRun()
    writeWrapperRun(run, agentDir)

    appendWrapperAuditEvent(
      {
        type: 'plan_submitted',
        timestamp: new Date().toISOString(),
        actor: 'agent',
        runId: run.runId,
        detail: {
          apiToken: 'sk-should-not-appear',
          note: 'safe to keep',
          nested: { password: 'also-secret', ref: 'secret://provider/resource-name' }
        }
      },
      agentDir
    )

    const globalEvents = readGlobalWrapperAuditEvents(agentDir)
    assert.equal(globalEvents.length, 1)
    assert.equal(globalEvents[0].detail?.apiToken, '[redacted]')
    assert.equal(globalEvents[0].detail?.note, 'safe to keep')
    assert.equal((globalEvents[0].detail?.nested as Record<string, unknown>).password, '[redacted]')
    assert.equal((globalEvents[0].detail?.nested as Record<string, unknown>).ref, '[redacted]')

    const runAuditPath = join(getWrapperRunsDir(agentDir), run.runId, 'audit.jsonl')
    const runAuditLines = readFileSync(runAuditPath, 'utf-8').trim().split('\n')
    assert.equal(runAuditLines.length, 1)
    assert.doesNotMatch(runAuditLines[0], /sk-should-not-appear/)
    assert.doesNotMatch(runAuditLines[0], /also-secret/)
  })
})

test('getWrappersRootDir stays scoped under the given agent dir', () => {
  withPhiDir((agentDir) => {
    assert.equal(getWrappersRootDir(agentDir), join(agentDir, 'wrappers'))
  })
})

test('redactSecretsDeep leaves non-secret values untouched', () => {
  const input = { wrapperId: 'phi/ngs/fastq-qc', threads: 4 }
  assert.deepEqual(redactSecretsDeep(input), input)
})
