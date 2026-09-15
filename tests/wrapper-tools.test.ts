import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  addCustomWrapper,
  ensureBundledWrappersInstalled
} from '../src/main/agent/wrappers/catalog'
import { readWrapperPlan } from '../src/main/agent/wrappers/store'
import {
  buildDefaultWrapperCustomTools,
  buildWrapperExecuteTool,
  buildWrapperInspectTool,
  buildWrapperSearchTool,
  wrapperToolName
} from '../src/main/agent/wrappers/tools'

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
  assert.equal(wrapperToolName('phi/ngs/fastq-qc'), 'wrapper.phi_ngs_fastq_qc')
})

test('buildDefaultWrapperCustomTools includes search, inspect, and only the bundled wrappers', async () => {
  await withHarness(({ agentDir, projectDir }) => {
    ensureBundledWrappersInstalled(agentDir)
    const sourceDir = join(projectDir, 'custom-src')
    mkdirSync(sourceDir, { recursive: true })
    writeCustomWrapperFixture(sourceDir)
    addCustomWrapper(sourceDir, agentDir)

    const tools = buildDefaultWrapperCustomTools(agentDir)
    const names = tools.map((tool) => tool.name)

    assert.ok(names.includes('wrapper.search'))
    assert.ok(names.includes('wrapper.inspect'))
    assert.ok(names.includes('wrapper.phi_ngs_fastq_qc'))
    assert.ok(names.includes('wrapper.nf_core_rnaseq_rnaseq'))
    assert.ok(names.includes('wrapper.nf_core_modules_fastqc'))
    assert.ok(names.includes('wrapper.nf_core_modules_trimgalore'))
    assert.ok(names.includes('wrapper.nf_core_modules_star_align'))
    assert.ok(names.includes('wrapper.nf_core_modules_salmon_quant'))
    assert.ok(names.includes('wrapper.nf_core_modules_multiqc'))
    assert.ok(!names.includes('wrapper.acme_tools_toy_wrapper'))
    assert.equal(tools.length, 9)
  })
})

test('wrapper.search finds wrappers by keyword across the full catalog, including custom ones', async () => {
  await withHarness(async ({ agentDir, projectDir }) => {
    ensureBundledWrappersInstalled(agentDir)
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

test('wrapper.inspect returns full manifest detail for a known id and an error for an unknown one', async () => {
  await withHarness(async ({ agentDir, projectDir }) => {
    ensureBundledWrappersInstalled(agentDir)
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
    ensureBundledWrappersInstalled(agentDir)
    writeFastqPair(projectDir, 'S1')

    const tools = buildDefaultWrapperCustomTools(agentDir)
    const fastqTool = tools.find((tool) => tool.name === 'wrapper.phi_ngs_fastq_qc')
    assert.ok(fastqTool)

    const result = await fastqTool!.execute(
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
    ensureBundledWrappersInstalled(agentDir)
    const tools = buildDefaultWrapperCustomTools(agentDir)
    const fastqTool = tools.find((tool) => tool.name === 'wrapper.phi_ngs_fastq_qc')
    assert.ok(fastqTool)

    const result = await fastqTool!.execute('call-1', {}, undefined, fakeCtx(projectDir) as never)

    assert.equal(result.isError, true)
    const details = result.details as { kind: string; planId: string }
    const plan = readWrapperPlan(details.planId, agentDir)
    assert.equal(plan?.state, 'invalid')
  })
})

test('generated execute-tool schema matches the manifest parameter schema exactly', async () => {
  await withHarness(({ agentDir }) => {
    const [entry] = ensureBundledWrappersInstalled(agentDir)
    const tool = buildWrapperExecuteTool(entry, agentDir)
    assert.deepEqual(tool.parameters, entry.manifest.parameters.schema)
  })
})
