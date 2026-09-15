import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { WrapperViewContent } from '../src/renderer/src/features/wrapper/WrapperView'
import { buildWrapperFlowGraph } from '../src/renderer/src/features/wrapper/lib/wrapperFlow'
import { resolveWrapperCancelTarget } from '../src/renderer/src/features/wrapper/lib/wrapperView'
import { readLegacyFastqQcWrapperManifest } from './helpers/wrapperFixtures'
import type { WrapperCatalogEntry } from '../src/shared/wrapperCatalogTypes'
import type { WrapperManifest } from '../src/shared/wrapperManifestTypes'
import type { WrapperRun, WrapperRunPlan } from '../src/shared/wrapperTypes'

function fastqQcManifest(): WrapperManifest {
  return readLegacyFastqQcWrapperManifest()
}

function bundledEntry(): WrapperCatalogEntry {
  return {
    manifest: fastqQcManifest(),
    trustTier: 'bundled',
    installedPath: '/tmp/installed/phi/ngs/fastq-qc/1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z'
  }
}

function customEntry(): WrapperCatalogEntry {
  return {
    manifest: { ...fastqQcManifest(), id: 'acme/tools/toy', shortId: 'toy', name: 'Toy Wrapper' },
    trustTier: 'custom',
    installedPath: '/tmp/installed/acme/tools/toy/1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z'
  }
}

function sampleRun(overrides: Partial<WrapperRun> = {}): WrapperRun {
  return {
    runId: 'wrun_abc123',
    planId: 'wplan_abc123',
    revision: 1,
    state: 'completed',
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
    outDir: '/tmp/project/results/phi-wrapper/fastq-qc/run',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
    ...overrides
  }
}

function renderView(overrides: Partial<Parameters<typeof WrapperViewContent>[0]> = {}): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(WrapperViewContent, {
        catalog: [bundledEntry()],
        runs: [],
        selectedId: 'phi/ngs/fastq-qc',
        isLoading: false,
        error: null,
        isAdding: false,
        sidebarWidth: 280,
        onSelect: () => undefined,
        onRefresh: () => undefined,
        onAddCustom: () => undefined,
        ...overrides
      })
    )
  )
}

test('wrapper view shows an empty state when no wrappers are installed', () => {
  const markup = renderView({ catalog: [], selectedId: null })
  assert.match(markup, /还没有安装任何 wrapper/)
})

test('wrapper view distinguishes bundled and custom trust tiers in the catalog list', () => {
  const markup = renderView({ catalog: [bundledEntry(), customEntry()] })
  assert.match(markup, /内置/)
  assert.match(markup, /自定义/)
})

test('wrapper view run history shows state and links to the output directory', () => {
  const markup = renderView({ runs: [sampleRun()] })
  assert.match(markup, /已完成/)
  assert.match(markup, /wrun_abc123/)
  assert.match(markup, /打开输出目录/)
})

test('wrapper view run history exposes a reproducibility export action', () => {
  const markup = renderView({ runs: [sampleRun()] })
  assert.match(markup, /导出可复现性元数据/)
})

test('wrapper view run history filters runs to the selected wrapper only', () => {
  const markup = renderView({
    runs: [
      sampleRun({
        runId: 'wrun_other',
        wrapper: {
          canonicalId: 'acme/tools/toy',
          namespace: 'acme/tools',
          shortId: 'toy',
          version: '1.0.0'
        }
      })
    ]
  })
  assert.match(markup, /还没有运行记录/)
  assert.doesNotMatch(markup, /wrun_other/)
})

test('wrapper detail diagram matches the plan card diagram for the same manifest', () => {
  const manifest = fastqQcManifest()
  const viewGraph = buildWrapperFlowGraph({ name: manifest.name, steps: manifest.steps })
  const planCardGraph = buildWrapperFlowGraph({ name: manifest.name, steps: manifest.steps })
  assert.deepEqual(viewGraph, planCardGraph)
})

// --- resolveWrapperCancelTarget ---------------------------------------
//
// Bug this covers: WrapperPlanCard.tsx's Cancel button used to only ever
// call cancelWrapperRunPlan and disabled itself once a plan was submitted
// — there was no way to cancel an in-flight run at all, even though
// window.api.cancelWrapperRun already existed. No test ever exercised this
// path (WrapperPlanCard.tsx had zero test coverage), which is exactly how
// it shipped unnoticed.

function planFixture(state: WrapperRunPlan['state']): Pick<WrapperRunPlan, 'planId' | 'state'> {
  return { planId: 'wplan_abc123', state }
}

function runFixture(state: WrapperRun['state']): Pick<WrapperRun, 'runId' | 'state'> {
  return { runId: 'wrun_abc123', state }
}

test('resolveWrapperCancelTarget targets the plan before submission', () => {
  for (const state of ['draft', 'valid', 'invalid'] as const) {
    assert.deepEqual(resolveWrapperCancelTarget(planFixture(state), undefined), {
      kind: 'plan',
      planId: 'wplan_abc123'
    })
  }
})

test('resolveWrapperCancelTarget has nothing to cancel for an expired or already-cancelled plan with no run', () => {
  for (const state of ['expired', 'cancelled', 'submitted'] as const) {
    assert.equal(resolveWrapperCancelTarget(planFixture(state), undefined), undefined)
  }
})

test('resolveWrapperCancelTarget switches to the run once one exists and is still pre-execution', () => {
  for (const state of ['created', 'validating', 'provisioning', 'queued'] as const) {
    assert.deepEqual(resolveWrapperCancelTarget(planFixture('submitted'), runFixture(state)), {
      kind: 'run',
      runId: 'wrun_abc123'
    })
  }
})

test("resolveWrapperCancelTarget has nothing to cancel once the run is actually running or terminal — matches cancelWrapperRun's own limits", () => {
  for (const state of [
    'running',
    'collecting',
    'completed',
    'failed',
    'cancelling',
    'cancelled',
    'lost'
  ] as const) {
    assert.equal(resolveWrapperCancelTarget(planFixture('submitted'), runFixture(state)), undefined)
  }
})

test('resolveWrapperCancelTarget prefers the run over the plan once both exist, even if the plan record is stale', () => {
  // The plan is still (stale-)"valid" here, but a run already exists — the
  // run must win, not fall back to a plan-cancel that runs.ts would reject.
  assert.deepEqual(resolveWrapperCancelTarget(planFixture('valid'), runFixture('queued')), {
    kind: 'run',
    runId: 'wrun_abc123'
  })
})
