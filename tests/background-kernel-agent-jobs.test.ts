import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  listBackgroundAgentJobs,
  type BackgroundAgentJobListingOptions
} from '../src/main/agent/jobs/background-agent-job-listing'
import {
  createPhiSession,
  recordKernelRuntimeReference
} from '../src/main/agent/session/session-store'

async function withPhiDir<T>(callback: (agentDir: string) => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR
  const agentDir = realpathSync(mkdtempSync(join(tmpdir(), 'phi-kernel-agent-jobs-')))
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    return await callback(agentDir)
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(agentDir, { recursive: true, force: true })
  }
}

function kernelSession(agentDir: string, kernelSessionId: string): string {
  const phi = createPhiSession({
    kind: 'ordinary',
    cwd: '/workspace',
    cwdRealPath: '/workspace',
    title: 'Kernel background work',
    permissionMode: 'auto'
  })
  recordKernelRuntimeReference(phi.sessionId, {
    kind: 'phi-kernel',
    version: 1,
    kernelSessionId,
    host: { kind: 'local', agentDir }
  })
  return phi.sessionId
}

function listingOptions(
  agentDir: string,
  phiSessionId: string,
  runs: readonly Record<string, unknown>[]
): BackgroundAgentJobListingOptions {
  return {
    agentDir,
    resolveRecoverableJobOrigin: (originSessionId) =>
      originSessionId === 'runtime-1' ? { phiSessionId, cwd: '/workspace' } : undefined,
    currentRuntimeOriginScope: () => undefined,
    optionalStringField: (record, key) =>
      typeof record[key] === 'string' ? (record[key] as string) : undefined,
    listAgentRuns: async () => runs
  }
}

function writeKernelReceipts(
  agentDir: string,
  kernelSessionId: string,
  receipts: readonly Record<string, unknown>[]
): void {
  const directory = join(agentDir, 'phi-kernel', 'sessions', kernelSessionId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'agent-runs.jsonl'),
    `${receipts.map((receipt) => JSON.stringify(receipt)).join('\n')}\n`
  )
}

test('kernel live background agent runs appear while running and after completion', () =>
  withPhiDir(async (agentDir) => {
    const phiSessionId = kernelSession(agentDir, 'kernel-live')
    const acceptedAt = '2026-11-10T08:00:00.000Z'
    const jobs = await listBackgroundAgentJobs(
      listingOptions(agentDir, phiSessionId, [
        {
          requestId: 'request-running',
          runId: 'run-running',
          agentSessionId: 'runtime-1',
          agent: 'General',
          task: 'Inspect the inputs',
          state: 'running',
          origin: 'tool',
          background: true,
          acceptedAt,
          startedAt: Date.parse('2026-11-10T08:00:01.000Z'),
          toolCalls: 2,
          lastStep: 'reading'
        },
        {
          requestId: 'request-done',
          runId: 'run-done',
          agentSessionId: 'runtime-1',
          agent: 'General',
          task: 'Inspect the outputs',
          state: 'done',
          origin: 'tool',
          background: true,
          acceptedAt,
          startedAt: Date.parse('2026-11-10T08:00:02.000Z'),
          completedAt: Date.parse('2026-11-10T08:01:00.000Z')
        }
      ])
    )

    assert.deepEqual(
      jobs.map((job) => [job.agentRunId, job.agentName, job.state]),
      [
        ['run-done', 'General', 'done'],
        ['run-running', 'General', 'running']
      ]
    )
    assert.equal(jobs[0]?.sessionId, phiSessionId)
    assert.equal(jobs[0]?.completedAt, '2026-11-10T08:01:00.000Z')
    assert.equal(jobs[1]?.toolCalls, 2)
  }))

test('kernel receipt journal restores background agents as cold jobs after restart', () =>
  withPhiDir(async (agentDir) => {
    const phiSessionId = kernelSession(agentDir, 'kernel-cold')
    const accepted = (
      requestId: string,
      agent: string,
      background: boolean
    ): Record<string, unknown> => ({
      state: 'accepted',
      requestId,
      agent,
      task: 'Persisted task',
      origin: 'tool',
      background,
      at: '2026-11-10T08:00:00.000Z'
    })
    const started = (
      requestId: string,
      runId: string,
      startedAt: number
    ): Record<string, unknown> => ({
      state: 'started',
      requestId,
      runId,
      startedAt,
      at: '2026-11-10T08:00:01.000Z'
    })
    const terminal = (
      requestId: string,
      runId: string,
      status: 'done' | 'error' | 'cancelled' | 'unknown',
      completedAt?: number
    ): Record<string, unknown> => ({
      state: 'terminal',
      requestId,
      runId,
      status,
      ...(completedAt === undefined ? {} : { completedAt }),
      at: '2026-11-10T08:02:00.000Z'
    })
    writeKernelReceipts(agentDir, 'kernel-cold', [
      accepted('request-done', 'General', true),
      started('request-done', 'run-done', 1000),
      terminal('request-done', 'run-done', 'done', 5000),
      accepted('request-error', 'Researcher', true),
      started('request-error', 'run-error', 2000),
      terminal('request-error', 'run-error', 'error', 6000),
      accepted('request-cancelled', 'Researcher', true),
      started('request-cancelled', 'run-cancelled', 3000),
      terminal('request-cancelled', 'run-cancelled', 'cancelled', 7000),
      accepted('request-unknown', 'Researcher', true),
      started('request-unknown', 'run-unknown', 4000),
      terminal('request-unknown', 'run-unknown', 'unknown'),
      accepted('request-open', 'Researcher', true),
      started('request-open', 'run-open', 5000),
      accepted('request-foreground', 'Researcher', false),
      started('request-foreground', 'run-foreground', 6000),
      terminal('request-foreground', 'run-foreground', 'done', 8000)
    ])

    const jobs = await listBackgroundAgentJobs(listingOptions(agentDir, phiSessionId, []))

    assert.deepEqual(
      jobs.map((job) => [job.agentRunId, job.agentName, job.state]),
      [
        ['run-open', 'Researcher', 'interrupted'],
        ['run-unknown', 'Researcher', 'interrupted'],
        ['run-cancelled', 'Researcher', 'cancelled'],
        ['run-error', 'Researcher', 'error'],
        ['run-done', 'General', 'done']
      ]
    )
    assert.deepEqual(
      jobs.map((job) => job.startedAt),
      [
        '1970-01-01T00:00:05.000Z',
        '1970-01-01T00:00:04.000Z',
        '1970-01-01T00:00:03.000Z',
        '1970-01-01T00:00:02.000Z',
        '1970-01-01T00:00:01.000Z'
      ]
    )
    for (const job of jobs) {
      assert.equal(job.sessionId, phiSessionId)
      assert.equal(job.sessionTitle, 'Kernel background work')
      assert.equal(job.background, true)
      assert.equal(job.canControl, false)
      assert.equal(job.historyAvailable, false)
    }
    assert.equal(jobs[0]?.completedAt, undefined)
    assert.equal(jobs[4]?.completedAt, '1970-01-01T00:00:05.000Z')
  }))
