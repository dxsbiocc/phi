import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWrapperRunPlan } from '../src/main/agent/wrappers/plans'
import { buildWrapperReproducibilityBundle } from '../src/main/agent/wrappers/reproducibility'
import {
  captureLocalRuntimeProvenance,
  collectWrapperContainerRefs
} from '../src/main/agent/wrappers/runtime-provenance'
import { submitWrapperRunPlan } from '../src/main/agent/wrappers/runs'
import { writeWrapperRuntimeProvenance } from '../src/main/agent/wrappers/store'
import { installLegacyFastqQcWrapper } from './helpers/wrapperFixtures'

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'phi-wrapper-runtime-prov-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function withTempDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'phi-wrapper-runtime-prov-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('collectWrapperContainerRefs extracts docker tags and singularity URLs across includes', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'modules'), { recursive: true })
    writeFileSync(
      join(dir, 'modules', 'fastqc.nf'),
      `process FASTQC {\n  container "\${ workflow.containerEngine == 'singularity' ? 'https://depot.galaxyproject.org/singularity/fastqc:0.12.1--hdfd78af_0' : 'biocontainers/fastqc:0.12.1--hdfd78af_0' }"\n}\n`,
      'utf-8'
    )
    writeFileSync(
      join(dir, 'main.nf'),
      `include { FASTQC } from './modules/fastqc'\n`,
      'utf-8'
    )
    assert.deepEqual(collectWrapperContainerRefs(join(dir, 'main.nf')), [
      'biocontainers/fastqc:0.12.1--hdfd78af_0',
      'https://depot.galaxyproject.org/singularity/fastqc:0.12.1--hdfd78af_0'
    ])
  })
})

test('captureLocalRuntimeProvenance records host OS/arch, Nextflow version/lockSha256, and container digests', async () => {
  await withTempDirAsync(async (dir) => {
    const mainNf = join(dir, 'main.nf')
    writeFileSync(
      mainNf,
      [
        'process A {',
        `  container 'quay.io/biocontainers/fastqc:0.12.1'`,
        '}',
        'process B {',
        `  container 'quay.io/biocontainers/multiqc:1.21'`,
        '}'
      ].join('\n'),
      'utf-8'
    )

    const provenance = await captureLocalRuntimeProvenance(
      {
        launch: {
          source: 'managed',
          ref: 'phi:nextflow@1',
          envId: 'env_nf_1',
          lockSha256: 'b'.repeat(64),
          command: '/phi/envs/env_nf_1/bin/nextflow',
          env: {},
          runtimeRoot: '/phi'
        },
        profile: 'docker',
        wrapperMainNf: mainNf
      },
      {
        host: { platform: 'darwin', arch: 'arm64', release: '24.1.0' },
        now: () => '2026-11-22T00:00:00.000Z',
        readNextflowVersion: async () => '25.04.6',
        probeCommand: async (command, args) => {
          if (command === 'docker' && args[0] === '--version') {
            return 'Docker version 27.3.1, build ce12230'
          }
          if (
            command === 'docker' &&
            args[0] === 'image' &&
            args[4] === 'quay.io/biocontainers/fastqc:0.12.1'
          ) {
            return JSON.stringify([`quay.io/biocontainers/fastqc@sha256:${'c'.repeat(64)}`])
          }
          return undefined
        }
      }
    )

    assert.deepEqual(provenance, {
      capturedAt: '2026-11-22T00:00:00.000Z',
      host: { platform: 'darwin', arch: 'arm64', release: '24.1.0' },
      nextflow: {
        source: 'managed',
        version: '25.04.6',
        ref: 'phi:nextflow@1',
        envId: 'env_nf_1',
        lockSha256: 'b'.repeat(64),
        resolvedCommand: '/phi/envs/env_nf_1/bin/nextflow'
      },
      containerRuntime: {
        engine: 'docker',
        version: 'Docker version 27.3.1, build ce12230',
        images: [
          {
            ref: 'quay.io/biocontainers/fastqc:0.12.1',
            digest: `quay.io/biocontainers/fastqc@sha256:${'c'.repeat(64)}`,
            status: 'verified'
          },
          {
            ref: 'quay.io/biocontainers/multiqc:1.21',
            status: 'unknown'
          }
        ]
      }
    })
  })
})

test('buildWrapperReproducibilityBundle includes persisted runtime provenance', () => {
  withTempDir((dir) => {
    const agentDir = join(dir, '.phi-home')
    const projectDir = join(dir, 'project')
    mkdirSync(join(projectDir, 'data'), { recursive: true })
    writeFileSync(join(projectDir, 'data', 'S1_R1.fastq.gz'), 'r1')
    writeFileSync(join(projectDir, 'data', 'S1_R2.fastq.gz'), 'r2')

    const entry = installLegacyFastqQcWrapper(agentDir, projectDir)
    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper: entry,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })
    const run = submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false })
    const runtime = writeWrapperRuntimeProvenance(
      run.runId,
      {
        capturedAt: '2026-11-22T00:00:00.000Z',
        host: { platform: 'linux', arch: 'x64', release: '6.8.0' },
        nextflow: { source: 'host', version: '25.10.0', resolvedCommand: '/usr/bin/nextflow' },
        containerRuntime: { engine: 'conda', images: [] }
      },
      agentDir
    )

    const bundle = buildWrapperReproducibilityBundle(run.runId, agentDir)
    assert.deepEqual(bundle.runtime, runtime)
  })
})
