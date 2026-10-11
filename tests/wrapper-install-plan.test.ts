import assert from 'node:assert/strict'
import test from 'node:test'

import type { PackageInstallPlanView } from '../src/shared/packageManagerTypes'
import { summarizeWrapperInstallPlan } from '../src/renderer/src/features/wrapper/lib/wrapperInstallPlan'

function plan(
  entries: Array<{ id: string; size: number; installedBy?: 'user' | 'dependency' }>
): PackageInstallPlanView {
  return {
    registry: {} as PackageInstallPlanView['registry'],
    root: { type: 'wrapper', id: entries[0]?.id ?? '', version: '1.0.0' },
    packages: entries.map((entry) => ({
      id: entry.id,
      type: 'wrapper',
      version: '1.0.0',
      title: entry.id,
      summary: '',
      archive: `${entry.id}.tar.gz`,
      sha256: 'a'.repeat(64),
      size: entry.size,
      dependsOn: [],
      installedBy: entry.installedBy ?? 'dependency'
    })),
    totalSize: entries.reduce((sum, entry) => sum + entry.size, 0),
    environments: [],
    agentDir: '/agent'
  }
}

test('a plan that only installs the chosen package needs no confirmation', () => {
  const summary = summarizeWrapperInstallPlan(
    plan([{ id: 'module-nf-core-samtools', size: 2048, installedBy: 'user' }]),
    'module-nf-core-samtools'
  )
  assert.equal(summary.needsConfirmation, false)
  assert.deepEqual(summary.dependencies, [])
  assert.equal(summary.totalSize, 2048)
})

test('dependencies are listed by tool name with their kind, largest-first order kept stable', () => {
  const summary = summarizeWrapperInstallPlan(
    plan([
      { id: 'module-nf-core-bowtie2', size: 1024 },
      { id: 'subworkflow-nf-core-bam-stats-samtools', size: 4096 },
      { id: 'subworkflow-local-align-bowtie2', size: 512, installedBy: 'user' },
      { id: 'workflow-nf-core-rnaseq', size: 100 }
    ]),
    'subworkflow-local-align-bowtie2'
  )
  assert.equal(summary.needsConfirmation, true)
  assert.deepEqual(
    summary.dependencies.map((entry) => [entry.name, entry.kind]),
    [
      ['bam-stats-samtools', '子流程'],
      ['bowtie2', '模块'],
      ['rnaseq', '工作流']
    ]
  )
  assert.equal(summary.root.name, 'align-bowtie2')
  assert.equal(summary.totalSize, 5732)
})
