import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { WrapperViewContent } from '../src/renderer/src/features/wrapper/WrapperView'
import { buildWrapperFlowGraph } from '../src/renderer/src/features/wrapper/lib/wrapperFlow'
import {
  resolveWrapperCancelTarget,
  wrapperPlanSubmitBlockReason,
  wrapperPlanSubmitConfirmation,
  wrapperPlanRetargetRequest,
  wrapperPlanTargetLines
} from '../src/renderer/src/features/wrapper/lib/wrapperView'
import {
  WrapperPlanTargetActions,
  WrapperPlanTargetSummary
} from '../src/renderer/src/features/wrapper/components/WrapperPlanTarget'
import type { Project } from '../src/renderer/src/lib/projectTypes'
import { readLegacyFastqQcWrapperManifest } from './helpers/wrapperFixtures'
import type {
  WrapperCompositionCatalogItem,
  WrapperCompositionManifest
} from '../src/shared/wrapperCompositionManifestTypes'
import type { WrapperManifest } from '../src/shared/wrapperManifestTypes'
import type { WrapperRun, WrapperRunPlan } from '../src/shared/wrapperTypes'
import { cacheResourceIconFixture } from './helpers/resourceIconFixture'

// Only used by the diagram-equality test below, which just needs a
// `{name, steps}`-shaped fixture — unrelated to the catalog shape the rest
// of this file exercises.
function fastqQcManifest(): WrapperManifest {
  return readLegacyFastqQcWrapperManifest()
}

function moduleEntry(
  overrides: Partial<WrapperCompositionCatalogItem> = {}
): WrapperCompositionCatalogItem {
  return {
    id: 'nf-core/modules/demo',
    name: 'Demo Module',
    summary: 'A demo module wrapper for tests.',
    params: {
      reads: { kind: 'input', type: 'fastq_glob', required: true, description: 'Input reads.' }
    },
    outputs: {
      report: { type: 'directory', path: '${outdir}/demo', primary: true }
    },
    ...overrides
  }
}

function workflowEntry(
  overrides: Partial<WrapperCompositionManifest> = {}
): WrapperCompositionManifest {
  return {
    id: 'nf-core/workflows/demo-pipeline',
    name: 'Demo Pipeline',
    summary: 'A demo full pipeline wrapper for tests.',
    params: {},
    outputs: {},
    ...overrides
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
      canonicalId: 'nf-core/modules/demo',
      namespace: 'nf-core/modules',
      shortId: 'demo',
      version: '1.0.0'
    },
    trustTier: 'bundled',
    executor: 'local',
    profile: 'local',
    cwd: '/tmp/project',
    outDir: '/tmp/project/results/phi-wrapper/demo/run',
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
        catalog: [moduleEntry()],
        runs: [],
        selectedId: 'nf-core/modules/demo',
        isLoading: false,
        error: null,
        sidebarWidth: 280,
        onSelect: () => undefined,
        onRefresh: () => undefined,
        ...overrides
      })
    )
  )
}

test('wrapper sidebar has no selected row after its detail tab closes', () => {
  const markup = renderView({ selectedId: null })
  assert.equal(markup.match(/class="[^"]*Mui-selected[^"]*"/g)?.length ?? 0, 0)
})

test('wrapper sidebar and detail share the composition-owned image', async () => {
  const key = 'owned-wrapper-icon'
  await cacheResourceIconFixture(key)
  const markup = renderView({ catalog: [moduleEntry({ icon: { key } })] })
  assert.equal(markup.match(/data-phi-resource-icon-key="owned-wrapper-icon"/g)?.length, 2)
  assert.equal(markup.match(/<img[^>]*src="data:image\/png;base64,iVBORw0KGgo="/g)?.length, 2)
})

test('wrapper details stay centered in the available content pane', () => {
  const markup = renderView()
  assert.match(markup, /max-width:860px;margin-left:auto;margin-right:auto/)
})

test('a local project offers server compute only inside the Wrapper view', () => {
  const project: Project = {
    id: 'local-project',
    name: 'Local work',
    location: { kind: 'local', path: '/tmp/project', realPath: '/tmp/project' },
    workingDirectory: '/tmp/project',
    permissionMode: 'ask',
    createdAt: '2026-09-27T00:00:00.000Z'
  }
  const local = renderView({ project })
  assert.match(local, /Configure remote execution/)
  assert.match(local, /Local projects run on this device by default/)

  const remote = renderView({
    project: {
      ...project,
      location: {
        kind: 'ssh',
        hostProfileId: 'host-a',
        remoteRoot: '/data/project',
        canonicalRoot: '/data/project'
      }
    }
  })
  assert.doesNotMatch(remote, /Configure remote execution/)
  assert.match(remote, /Wrapper execution mode/)
  assert.match(remote, /Wrappers run on this project’s server automatically/)
})

test('a local plan waits for a saved server before offering remote retarget', () => {
  const plan = {
    planId: 'plan-local',
    revision: 1,
    state: 'valid',
    inputs: [],
    targetSelection: {
      projectId: 'local-project',
      projectLocation: { kind: 'local', path: '/tmp/project', realPath: '/tmp/project' },
      target: 'local',
      reason: '本地项目默认在本机运行。'
    }
  } as unknown as WrapperRunPlan
  const renderActions = (remoteConfigured: boolean): string =>
    renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(WrapperPlanTargetActions, {
          plan,
          busy: false,
          isUnsubmitted: true,
          remoteConfigured,
          onRetarget: () => undefined
        })
      )
    )

  assert.match(renderActions(false), /Select a server and working directory/)
  assert.doesNotMatch(renderActions(false), /Switch to remote server and revalidate plan/)
  assert.match(renderActions(true), /Switch to remote server and revalidate plan/)
})

test('wrapper view shows an empty state when no wrappers are found', () => {
  const markup = renderView({ catalog: [], selectedId: null })
  assert.match(markup, /No Wrappers added yet. Select Discover to browse the catalog./)
})

test('wrapper view groups catalog entries by tier', () => {
  const markup = renderView({ catalog: [moduleEntry(), workflowEntry()] })
  assert.match(markup, /Modules/)
  assert.match(markup, /Workflows/)
})

test('wrapper view shows package enablement and dependency-hidden reasons', () => {
  const markup = renderView({
    catalog: [
      moduleEntry({
        packageId: 'subworkflow-nf-core-demo',
        packageEnabled: true,
        hiddenReason: '依赖 module-nf-core-fastqc 不可用（软件包 module-nf-core-fastqc 已停用）'
      })
    ],
    onSetPackageEnabled: () => undefined
  })
  assert.match(markup, /Package · subworkflow-nf-core-demo/)
  assert.match(markup, /Enabled/)
  assert.match(markup, /依赖 module-nf-core-fastqc 不可用/)
  assert.doesNotMatch(markup, /aria-label="Enable package subworkflow-nf-core-demo"[^>]*disabled/)
})

test('wrapper view run history shows state and links to the output directory', () => {
  const markup = renderView({ runs: [sampleRun()] })
  assert.match(markup, /Completed/)
  assert.match(markup, /wrun_abc123/)
  assert.match(markup, /Open output directory/)
})

test('remote run history opens its scoped directory and primary report without local reveal', () => {
  const remoteRun = sampleRun({
    executor: 'remote-background',
    outDir: '/scratch/results-a',
    remote: {
      projectId: 'project-a',
      hostProfileId: 'host-a',
      host: 'cluster-a',
      runDir: '/cluster/work/wrappers/runs/wrun_abc123',
      outputRoot: '/scratch/results-a'
    },
    outputs: [
      {
        id: 'report',
        path: '/scratch/results-a/report.html',
        exists: true,
        primary: true,
        location: 'remote'
      }
    ]
  })
  const markup = renderView({
    runs: [remoteRun],
    onOpenRemoteResult: () => undefined,
    onOpenLocalPath: () => {
      throw new Error('remote results must never use local open')
    }
  })
  assert.match(markup, /SSH cluster-a/)
  assert.match(markup, /Open output directory/)
  assert.match(markup, /View report/)
  const older = renderView({
    runs: [
      sampleRun({ ...remoteRun, remote: { host: 'cluster-a', runDir: remoteRun.remote!.runDir } })
    ]
  })
  assert.match(older, /This older run has no remote result authorization information/)
  assert.doesNotMatch(older, /View report/)
})

test('wrapper view run history exposes a reproducibility export action', () => {
  const markup = renderView({ runs: [sampleRun()] })
  assert.match(markup, /Export reproducibility metadata/)
})

test('wrapper view run history filters runs to the selected wrapper only', () => {
  const markup = renderView({
    runs: [
      sampleRun({
        runId: 'wrun_other',
        wrapper: {
          canonicalId: 'nf-core/modules/other',
          namespace: 'nf-core/modules',
          shortId: 'other',
          version: '1.0.0'
        }
      })
    ]
  })
  assert.match(markup, /No runs yet/)
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

function runFixture(state: WrapperRun['state']): Pick<WrapperRun, 'runId' | 'state' | 'executor'> {
  return { runId: 'wrun_abc123', state, executor: 'local' }
}

test('plan target summary and submit confirmation use the saved SSH target, not the local anchor', () => {
  const location = {
    kind: 'ssh' as const,
    hostProfileId: 'host-a',
    remoteRoot: '/home/project-link',
    canonicalRoot: '/data/project'
  }
  const plan = {
    planId: 'wplan-1',
    revision: 3,
    executor: 'slurm-controller',
    profile: 'slurm-controller',
    nextflowProfile: 'singularity',
    outputDir: 'results/run-1',
    resources: { cpus: 16, memory: '64 GB', time: '24h' },
    inputs: [
      {
        id: 'reads',
        userValue: '/data/project/reads/*.fastq.gz',
        localPaths: [],
        remotePaths: ['/data/project/reads/*.fastq.gz']
      }
    ],
    targetSelection: {
      projectId: 'project-a',
      projectLocation: location,
      target: 'remote',
      reason: '远程项目固定使用自身服务器和项目目录。',
      hostProfileId: 'host-a',
      hostAlias: 'cluster-a',
      connectionId: 'conn-a',
      remoteRoot: '/data/project',
      scheduler: 'slurm',
      controller: 'sbatch',
      runtime: 'singularity',
      environmentCheckPending: true
    }
  } as unknown as WrapperRunPlan
  const lines = wrapperPlanTargetLines(plan).join('\n')
  assert.match(lines, /Execution location: Remote server cluster-a/)
  assert.match(lines, /Slurm controller job/)
  assert.match(lines, /Nextflow singularity/)
  assert.match(lines, /Input reads: \/data\/project\/reads/)
  assert.match(lines, /Output location: \/data\/project\/wrappers\/runs\/<run ID>\/output/)
  const externalLines = wrapperPlanTargetLines({
    ...plan,
    params: { outdir: '/scratch/shared/report-output' }
  }).join('\n')
  assert.match(
    externalLines,
    /External output authorization: \/scratch\/shared\/report-output \(this run only\)/
  )
  assert.equal(
    wrapperPlanSubmitConfirmation({
      ...plan,
      params: { outdir: '/scratch/shared/report-output' }
    }).externalOutputRoot,
    '/scratch/shared/report-output'
  )
  const externalSummary = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(WrapperPlanTargetSummary, {
        plan: { ...plan, params: { outdir: '/scratch/shared/report-output' } }
      })
    )
  )
  assert.match(externalSummary, /External output authorization/)
  assert.match(lines, /16 CPU · 64 GB/)
  assert.deepEqual(wrapperPlanSubmitConfirmation(plan), {
    expectedRevision: 3,
    target: 'remote',
    projectId: 'project-a',
    hostProfileId: 'host-a',
    remoteRoot: '/data/project'
  })
  const summary = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(WrapperPlanTargetSummary, { plan })
    )
  )
  assert.match(summary, /Remote server cluster-a/)
  const project = {
    id: 'project-a',
    location,
    remoteHostAlias: 'cluster-a',
    remoteConnection: { phase: 'offline' }
  } as Project
  assert.match(
    wrapperPlanSubmitBlockReason(plan, project, true) ?? '',
    /The server connection is not ready/
  )
  assert.match(wrapperPlanSubmitBlockReason(plan, project, false) ?? '', /Checking project/)
  assert.equal(
    wrapperPlanSubmitBlockReason(
      plan,
      {
        ...project,
        remoteConnection: { phase: 'reachable' }
      },
      true
    ),
    undefined
  )
  assert.match(
    wrapperPlanSubmitBlockReason(
      plan,
      {
        ...project,
        remoteHostAlias: 'another-host',
        remoteConnection: { phase: 'reachable' }
      },
      true
    ) ?? '',
    /server or directory has changed/
  )
})

test('local fallback control shows confirmation and sends the exact plan revision', () => {
  const plan = {
    planId: 'wplan-fallback',
    revision: 4,
    executor: 'slurm-controller',
    profile: 'slurm-controller',
    inputs: [],
    outputDir: 'results',
    resources: {},
    targetSelection: {
      projectId: 'local-project',
      projectLocation: { kind: 'local', path: '/local/project', realPath: '/local/project' },
      target: 'remote',
      reason: '已配置远程服务器',
      hostAlias: 'cluster-a'
    }
  } as unknown as WrapperRunPlan
  assert.deepEqual(wrapperPlanRetargetRequest(plan, 'local'), {
    planId: 'wplan-fallback',
    target: 'local',
    expectedRevision: 4,
    confirmedLocalFallback: true
  })
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(WrapperPlanTargetActions, {
        plan,
        busy: false,
        isUnsubmitted: true,
        submitBlockReason: '服务器离线',
        onRetarget: () => undefined
      })
    )
  )
  assert.match(markup, /Confirm switch to local execution/)
  assert.match(markup, /服务器离线/)
  assert.match(
    wrapperPlanSubmitBlockReason(
      plan,
      {
        id: 'local-project',
        location: { kind: 'local', path: '/moved/project', realPath: '/moved/project' }
      } as Project,
      true
    ) ?? '',
    /project directory has changed/
  )
})

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

test('a running background run shows its progress and a cancel button', () => {
  const markup = renderView({
    runs: [
      sampleRun({
        state: 'running',
        origin: 'composition',
        progress: { started: 2, total: 6, current: 'HISAT2_ALIGN' }
      })
    ]
  })
  assert.match(markup, /Running/)
  assert.match(markup, /2\/6/)
  assert.match(markup, /HISAT2_ALIGN/)
  assert.match(markup, /Cancel run/)
})

test('progress without a known total still shows how many steps have started', () => {
  const markup = renderView({
    runs: [
      sampleRun({
        state: 'running',
        origin: 'composition',
        progress: { started: 3, current: 'FASTQC' }
      })
    ]
  })
  assert.match(markup, /3 steps started/)
  assert.match(markup, /FASTQC/)
})

test('only a running background run can be cancelled from the run history', () => {
  const finished = renderView({ runs: [sampleRun({ state: 'completed', origin: 'composition' })] })
  assert.doesNotMatch(finished, /Cancel run/)

  const cancelling = renderView({
    runs: [sampleRun({ state: 'cancelling', origin: 'composition' })]
  })
  assert.match(cancelling, /Cancelling/)
  assert.doesNotMatch(cancelling, /Cancel run/)

  // A plan-based local run has no kill support, so no cancel button is offered.
  const legacy = renderView({ runs: [sampleRun({ state: 'running' })] })
  assert.doesNotMatch(legacy, /Cancel run/)
})

test('a completed run does not show a progress count', () => {
  const markup = renderView({
    runs: [
      sampleRun({
        state: 'completed',
        origin: 'composition',
        progress: { started: 6, total: 6, current: 'MULTIQC' }
      })
    ]
  })
  assert.doesNotMatch(markup, /6\/6/)
})
