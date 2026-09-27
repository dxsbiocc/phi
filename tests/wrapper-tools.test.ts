import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { addCustomWrapper } from '../src/main/agent/wrappers/catalog'
import { readWrapperPlan } from '../src/main/agent/wrappers/store'
import {
  buildDefaultWrapperCustomTools,
  buildWrapperExecuteTool,
  buildWrapperInspectTool,
  buildWrapperSearchTool,
  wrapperToolName
} from '../src/main/agent/wrappers/tools'
import { installLegacyFastqQcWrapper } from './helpers/wrapperFixtures'

// Always resolves the callback through a Promise chain before cleanup runs —
// a plain try/finally would run rmSync as soon as an async callback returns
// its pending promise, deleting the harness dir out from under work still
// in flight (that exact bug produced flaky "plan not found" failures here
// until this was fixed; see wrapper-executor.test.ts for the same pattern).
function withHarness<T>(
  callback: (h: { agentDir: string; projectDir: string }) => T | Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-tools-'))
  const agentDir = join(root, '.phi-home')
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  return Promise.resolve(callback({ agentDir, projectDir })).finally(() =>
    rmSync(root, { recursive: true, force: true })
  )
}

function writeFastqPair(projectDir: string, sample: string): void {
  mkdirSync(join(projectDir, 'data'), { recursive: true })
  writeFileSync(join(projectDir, 'data', `${sample}_R1.fastq.gz`), 'r1')
  writeFileSync(join(projectDir, 'data', `${sample}_R2.fastq.gz`), 'r2')
}

function writeCustomWrapperFixture(dir: string): void {
  writeFileSync(
    join(dir, 'wrapper.yaml'),
    `phiWrapperVersion: 1
id: acme/tools/toy-wrapper
shortId: toy-wrapper
name: Toy Wrapper
version: 0.1.0
summary: A tiny wrapper for tests.
runtime:
  minVersion: 1.0.0
  maxVersion: 1.x
resourceClass: light
engine:
  type: nextflow
  entrypoint: main.nf
  profiles:
    - id: local
      executor: local
inputs: []
parameters:
  schema:
    type: object
    properties: {}
outputs:
  - id: report
    label: Report
    type: html
    path: results/report.html
resources:
  defaults:
    cpus: 1
`,
    'utf-8'
  )
}

function fakeCtx(cwd: string): { sessionManager: { getCwd: () => string } } {
  return { sessionManager: { getCwd: () => cwd } }
}

test('wrapperToolName sanitizes a canonical id into a safe tool name', () => {
  assert.equal(wrapperToolName('phi/ngs/fastq-qc'), 'wrapper_phi_ngs_fastq_qc')
})

test('buildDefaultWrapperCustomTools includes only legacy search and inspect without bundled packages', async () => {
  await withHarness(({ agentDir, projectDir }) => {
    const sourceDir = join(projectDir, 'custom-src')
    mkdirSync(sourceDir, { recursive: true })
    writeCustomWrapperFixture(sourceDir)
    addCustomWrapper(sourceDir, agentDir)

    const tools = buildDefaultWrapperCustomTools(agentDir)
    const names = tools.map((tool) => tool.name)

    assert.ok(names.includes('wrapper_search'))
    assert.ok(names.includes('wrapper_inspect'))
    assert.ok(!names.includes('wrapper_acme_tools_toy_wrapper'))
    assert.equal(tools.length, 2)
  })
})

test('wrapper_search finds wrappers by keyword across the full catalog, including custom ones', async () => {
  await withHarness(async ({ agentDir, projectDir }) => {
    const sourceDir = join(projectDir, 'custom-src')
    mkdirSync(sourceDir, { recursive: true })
    writeCustomWrapperFixture(sourceDir)
    addCustomWrapper(sourceDir, agentDir)

    const tool = buildWrapperSearchTool(agentDir)
    const result = await tool.execute(
      'call-1',
      { query: 'toy' },
      undefined,
      fakeCtx(projectDir) as never
    )

    assert.equal(result.isError, undefined)
    const details = result.details as { results: Array<{ id: string }> }
    assert.deepEqual(
      details.results.map((item) => item.id),
      ['acme/tools/toy-wrapper']
    )
  })
})

test('wrapper_inspect returns full manifest detail for a known id and an error for an unknown one', async () => {
  await withHarness(async ({ agentDir, projectDir }) => {
    installLegacyFastqQcWrapper(agentDir, projectDir)
    const tool = buildWrapperInspectTool(agentDir)

    const found = await tool.execute(
      'call-1',
      { id: 'phi/ngs/fastq-qc' },
      undefined,
      fakeCtx(projectDir) as never
    )
    assert.equal(found.isError, undefined)
    const details = found.details as { manifest: { id: string; inputs: unknown[] } }
    assert.equal(details.manifest.id, 'phi/ngs/fastq-qc')
    assert.ok(Array.isArray(details.manifest.inputs))

    const missing = await tool.execute(
      'call-2',
      { id: 'does/not/exist' },
      undefined,
      fakeCtx(projectDir) as never
    )
    assert.equal(missing.isError, true)
  })
})

test('a wrapper execute tool creates a plan with actor "agent" and never submits it', async () => {
  await withHarness(async ({ agentDir, projectDir }) => {
    const entry = installLegacyFastqQcWrapper(agentDir, projectDir)
    writeFastqPair(projectDir, 'S1')

    const fastqTool = buildWrapperExecuteTool(entry, agentDir)

    const result = await fastqTool.execute(
      'call-1',
      { reads: 'data/*_{R1,R2}.fastq.gz' },
      undefined,
      fakeCtx(projectDir) as never
    )

    assert.equal(result.isError, undefined)
    const details = result.details as { kind: string; planId: string }
    assert.equal(details.kind, 'wrapper_plan')

    const plan = readWrapperPlan(details.planId, agentDir)
    assert.equal(plan?.actor, 'agent')
    assert.equal(plan?.state, 'valid')
    assert.equal(plan?.executor, 'local')
  })
})

test('an execute tool call with invalid params creates an invalid plan and reports the error, without throwing', async () => {
  await withHarness(async ({ agentDir, projectDir }) => {
    const entry = installLegacyFastqQcWrapper(agentDir, projectDir)
    const fastqTool = buildWrapperExecuteTool(entry, agentDir)

    const result = await fastqTool.execute('call-1', {}, undefined, fakeCtx(projectDir) as never)

    assert.equal(result.isError, true)
    const details = result.details as { kind: string; planId: string }
    const plan = readWrapperPlan(details.planId, agentDir)
    assert.equal(plan?.state, 'invalid')
  })
})

test('generated execute-tool schema preserves options and allows explicit input provenance', async () => {
  await withHarness(({ agentDir, projectDir }) => {
    const entry = installLegacyFastqQcWrapper(agentDir, projectDir)
    const tool = buildWrapperExecuteTool(entry, agentDir)
    const schema = tool.parameters as Record<string, unknown>
    const original = entry.manifest.parameters.schema
    assert.equal(schema.type, original.type)
    assert.deepEqual(schema.required, original.required)
    const properties = schema.properties as Record<string, unknown>
    const originalProperties = original.properties as Record<string, unknown>
    assert.deepEqual(properties.threads, originalProperties.threads)
    const reads = properties.reads as { anyOf: unknown[] }
    assert.deepEqual(reads.anyOf[0], originalProperties.reads)
    assert.deepEqual(reads.anyOf[1], {
      type: 'object',
      required: ['source', 'path'],
      additionalProperties: false,
      properties: {
        source: { type: 'string', enum: ['local', 'remote'] },
        path: { type: 'string', minLength: 1 }
      }
    })
  })
})
