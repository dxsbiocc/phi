import assert from 'node:assert/strict'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import test from 'node:test'

import {
  captureWorkspaceStepEvidenceFingerprints,
  evaluateWorkspacePlanStaleness,
  evaluateWorkspaceStepCompatibility,
  verifyWorkspacePlanStepChecks
} from '../src/main/agent/plan/execution/workspace-step-verifier'
import { writeRemoteScientificContextSidecar } from '../src/main/agent/scientific-context/remote-sidecar'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'
import { observedValue } from '../src/shared/scientificContextTypes'
import type { PlanSpec, PlanStep } from '../src/shared/planRunTypes'

/** Simulates a POSIX remote host backed by an isolated local directory, never touching local workspace paths directly. */
function createLoopbackSshSession(backingRoot: string, disconnected = false): RemoteSshSession {
  const mapPath = (remotePosixPath: string): string => {
    const clean = posix.resolve(remotePosixPath)
    return clean.startsWith(backingRoot) ? clean : join(backingRoot, clean)
  }

  return {
    async exec(command: string) {
      if (disconnected) throw new Error('SSH connection lost')
      // Replace remote virtual `/remote/proj` references with `backingRoot/remote/proj` for real POSIX shell execution
      const rewritten = command.replaceAll("'/remote/", `'${backingRoot}/remote/`)
      const { spawnSync } = await import('node:child_process')
      const proc = spawnSync('sh', ['-c', rewritten], { encoding: 'utf-8' })
      return {
        stdout: proc.stdout ?? '',
        stderr: proc.stderr ?? '',
        code: proc.status,
        signal: proc.signal
      }
    },
    async readFileChunk(remotePath, options) {
      if (disconnected) throw new Error('SSH connection lost')
      const local = mapPath(remotePath)
      const full = readFileSync(local)
      const start = Math.min(options.offset, full.byteLength)
      const end = Math.min(start + options.maxBytes, full.byteLength)
      const slice = full.subarray(start, end)
      return {
        missing: false,
        bytes: slice,
        size: full.byteLength,
        startOffset: start,
        nextOffset: end
      }
    },
    async readTextFile(remotePath) {
      if (disconnected) throw new Error('SSH connection lost')
      return readFileSync(mapPath(remotePath), 'utf-8')
    },
    async writeTextFile(remotePath, content) {
      if (disconnected) throw new Error('SSH connection lost')
      const local = mapPath(remotePath)
      mkdirSync(join(local, '..'), { recursive: true })
      writeFileSync(local, content, 'utf-8')
    },
    async mkdirp(remotePath) {
      if (disconnected) throw new Error('SSH connection lost')
      mkdirSync(mapPath(remotePath), { recursive: true })
    },
    async exists(remotePath) {
      if (disconnected) throw new Error('SSH connection lost')
      try {
        lstatSync(mapPath(remotePath))
        return true
      } catch {
        return false
      }
    },
    async uploadFile() {
      throw new Error('not implemented')
    },
    async close() {
      return undefined
    }
  }
}

test('SSH remote workspace verifies table_schema checks, blocks symlink escapes, and fails closed on disconnect or missing workspace', async () => {
  const backing = realpathSync(mkdtempSync(join(tmpdir(), 'phi-remote-verify-')))
  try {
    const remoteRoot = '/remote/proj'
    const mappedProj = join(backing, 'remote', 'proj')
    const outsideDir = join(backing, 'remote', 'secret')
    mkdirSync(join(mappedProj, 'results'), { recursive: true })
    mkdirSync(outsideDir, { recursive: true })

    writeFileSync(
      join(mappedProj, 'results', 'de.tsv'),
      'gene_id\tlog2FoldChange\tpadj\nG1\t1.8\t0.004\n'
    )
    writeFileSync(join(mappedProj, 'results', 'empty.tsv'), '')
    writeFileSync(join(outsideDir, 'leaked.tsv'), 'gene_id\tpadj\nG1\t0.01\n')
    symlinkSync(join(outsideDir, 'leaked.tsv'), join(mappedProj, 'results', 'escape.tsv'))

    const session = createLoopbackSshSession(backing, false)
    const remoteWorkspace = {
      kind: 'remote' as const,
      target: {
        rootDir: remoteRoot,
        host: 'hpc-login',
        getSshSession: async () => session
      }
    }

    const baseStep: Omit<PlanStep, 'checks'> = {
      id: 's1',
      title: 'Verify DE',
      instructions: 'Run DE',
      acceptance: 'Valid DE table',
      dependsOn: [],
      access: 'write'
    }

    // 1. Valid remote TSV passes
    const passRes = await verifyWorkspacePlanStepChecks(
      {
        ...baseStep,
        checks: [
          {
            kind: 'table_schema',
            path: 'results/de.tsv',
            format: 'tsv',
            minDataRows: 1,
            requiredColumns: ['gene_id', 'padj']
          }
        ]
      },
      remoteWorkspace
    )
    assert.deepEqual(passRes, { ok: true, failures: [] })

    // 2. Empty remote file fails
    const emptyRes = await verifyWorkspacePlanStepChecks(
      {
        ...baseStep,
        checks: [{ kind: 'non_empty_file', path: 'results/empty.tsv' }]
      },
      remoteWorkspace
    )
    assert.equal(emptyRes.ok, false)

    // 3. Symlink escaping remoteRoot fails
    const symlinkRes = await verifyWorkspacePlanStepChecks(
      {
        ...baseStep,
        checks: [{ kind: 'file_exists', path: 'results/escape.tsv' }]
      },
      remoteWorkspace
    )
    assert.equal(symlinkRes.ok, false)
    assert.ok(symlinkRes.failures[0]?.includes('escapes allowed root'))

    // 4. Unavailable workspace fails closed (never silently ok: true!)
    const unavailRes = await verifyWorkspacePlanStepChecks(
      {
        ...baseStep,
        checks: [{ kind: 'file_exists', path: 'results/de.tsv' }]
      },
      { kind: 'unavailable' }
    )
    assert.equal(unavailRes.ok, false)

    // 5. Remote sidecar preflight passes when compatible, blocks on mismatch, and pauses on SSH disconnect
    await writeRemoteScientificContextSidecar(session, '/remote/proj/results/de.tsv', {
      producer: { kind: 'wrapper', id: 'nf-core/modules/salmon', runId: 'wrun_1' },
      host: 'hpc-login',
      path: '/remote/proj/results/de.tsv',
      hashRemoteBytes: true,
      remoteRootDir: remoteRoot,
      reference: observedValue({ assembly: 'GRCh38' }, 'wrapper_param:salmon'),
      matrix: observedValue({ valueSemantics: 'raw_counts' }, 'wrapper_manifest:salmon')
    })

    const compatStep: PlanStep = {
      ...baseStep,
      inputContracts: [
        {
          path: 'results/de.tsv',
          expectedReferenceAssembly: 'GRCh38',
          requiredMatrixSemantics: ['raw_counts']
        }
      ]
    }
    const compatOk = await evaluateWorkspaceStepCompatibility(compatStep, remoteWorkspace)
    assert.deepEqual(compatOk, { status: 'compatible' })

    const mismatchStep: PlanStep = {
      ...baseStep,
      inputContracts: [
        {
          path: 'results/de.tsv',
          requiredMatrixSemantics: ['tpm']
        }
      ]
    }
    const compatBad = await evaluateWorkspaceStepCompatibility(mismatchStep, remoteWorkspace)
    assert.equal(compatBad.status, 'incompatible')

    const disconnectedWorkspace = {
      kind: 'remote' as const,
      target: {
        rootDir: remoteRoot,
        host: 'hpc-login',
        getSshSession: async () => createLoopbackSshSession(backing, true)
      }
    }
    const disconnRes = await evaluateWorkspaceStepCompatibility(compatStep, disconnectedWorkspace)
    assert.equal(disconnRes.status, 'needs_input')
    if (disconnRes.status === 'needs_input') {
      assert.ok(disconnRes.summary.includes('hpc-login'))
    }

    // 6. Remote SHA-256 evidence fingerprint capture and staleness propagation
    const downstreamStep: PlanStep = {
      ...baseStep,
      id: 'step-gsea',
      title: 'Downstream GSEA',
      dependsOn: ['s1']
    }
    const spec: PlanSpec = {
      version: 1,
      goal: 'Remote RNA-seq DE + GSEA',
      steps: [compatStep, downstreamStep]
    }
    const captured = await captureWorkspaceStepEvidenceFingerprints([compatStep], remoteWorkspace)
    assert.ok(captured)
    assert.ok(captured.s1?.inputs[0]?.contentSha256)

    const cleanReport = await evaluateWorkspacePlanStaleness(spec, captured, remoteWorkspace)
    assert.ok(cleanReport)
    assert.deepEqual(cleanReport.staleSteps, {})

    // Mutate remote input file in place -> both s1 and downstream step-gsea become stale!
    writeFileSync(
      join(mappedProj, 'results', 'de.tsv'),
      'gene_id\tlog2FoldChange\tpadj\nGENE1\t9.9\t0.0001\n'
    )
    const staleReport = await evaluateWorkspacePlanStaleness(spec, captured, remoteWorkspace)
    assert.ok(staleReport)
    assert.ok(staleReport.staleSteps.s1)
    assert.deepEqual(staleReport.staleSteps['step-gsea']?.propagatedFrom, ['s1'])
  } finally {
    rmSync(backing, { recursive: true, force: true })
  }
})
