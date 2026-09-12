import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { startWeblogListener } from '../src/main/agent/wrappers/weblog-listener'
import { readWrapperRun, writeWrapperRun } from '../src/main/agent/wrappers/store'
import type { WrapperRun } from '../src/main/agent/wrappers/types'

const STEPS = [
  { id: 'fastqc', label: 'FastQC', dependsOn: [] },
  { id: 'multiqc', label: 'MultiQC', dependsOn: ['fastqc'] }
]

function withAgentDir<T>(callback: (agentDir: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-weblog-'))
  const agentDir = join(root, '.phi-home')
  return callback(agentDir).finally(() => rmSync(root, { recursive: true, force: true }))
}

function sampleRun(overrides: Partial<WrapperRun> = {}): WrapperRun {
  const now = new Date().toISOString()
  return {
    runId: 'wrun_weblog1',
    planId: 'wplan_weblog1',
    revision: 1,
    state: 'running',
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
    cwd: '/tmp/project',
    outDir: 'results/phi-wrapper/fastq-qc/run',
    steps: STEPS,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

async function postWeblog(url: string, payload: unknown): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

test('weblog listener attributes a matched process event to the right step', async () => {
  await withAgentDir(async (agentDir) => {
    writeWrapperRun(sampleRun(), agentDir)
    const handle = await startWeblogListener('wrun_weblog1', STEPS, agentDir)
    try {
      await postWeblog(handle.url, { event: 'process_started', trace: { process: 'fastqc' } })
      await new Promise((resolve) => setTimeout(resolve, 20))

      const run = readWrapperRun('wrun_weblog1', agentDir)
      assert.equal(run?.stepStates?.fastqc, 'running')

      await postWeblog(handle.url, {
        event: 'process_completed',
        trace: { process: 'fastqc', status: 'COMPLETED' }
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const completedRun = readWrapperRun('wrun_weblog1', agentDir)
      assert.equal(completedRun?.stepStates?.fastqc, 'completed')
    } finally {
      await handle.stop()
    }
  })
})

test('weblog listener matches a tagged trace name like "fastqc (sample1)"', async () => {
  await withAgentDir(async (agentDir) => {
    writeWrapperRun(sampleRun(), agentDir)
    const handle = await startWeblogListener('wrun_weblog1', STEPS, agentDir)
    try {
      await postWeblog(handle.url, {
        event: 'process_started',
        trace: { name: 'fastqc (sample1)' }
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const run = readWrapperRun('wrun_weblog1', agentDir)
      assert.equal(run?.stepStates?.fastqc, 'running')
    } finally {
      await handle.stop()
    }
  })
})

test('weblog listener marks a step failed when Nextflow reports a failed status', async () => {
  await withAgentDir(async (agentDir) => {
    writeWrapperRun(sampleRun(), agentDir)
    const handle = await startWeblogListener('wrun_weblog1', STEPS, agentDir)
    try {
      await postWeblog(handle.url, {
        event: 'process_completed',
        trace: { process: 'multiqc', status: 'FAILED' }
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const run = readWrapperRun('wrun_weblog1', agentDir)
      assert.equal(run?.stepStates?.multiqc, 'failed')
    } finally {
      await handle.stop()
    }
  })
})

test('weblog listener never fabricates a step state for an unmatched process name', async () => {
  await withAgentDir(async (agentDir) => {
    writeWrapperRun(sampleRun(), agentDir)
    const handle = await startWeblogListener('wrun_weblog1', STEPS, agentDir)
    try {
      await postWeblog(handle.url, {
        event: 'process_started',
        trace: { process: 'some_unrelated_process' }
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const run = readWrapperRun('wrun_weblog1', agentDir)
      assert.deepEqual(run?.stepStates ?? {}, {})
    } finally {
      await handle.stop()
    }
  })
})

test('weblog listener ignores malformed payloads without crashing', async () => {
  await withAgentDir(async (agentDir) => {
    writeWrapperRun(sampleRun(), agentDir)
    const handle = await startWeblogListener('wrun_weblog1', STEPS, agentDir)
    try {
      await fetch(handle.url, { method: 'POST', body: 'not json' })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const run = readWrapperRun('wrun_weblog1', agentDir)
      assert.deepEqual(run?.stepStates ?? {}, {})
    } finally {
      await handle.stop()
    }
  })
})
