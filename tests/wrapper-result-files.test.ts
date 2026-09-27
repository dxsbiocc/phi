import assert from 'node:assert/strict'
import test from 'node:test'
import { Children, type ReactElement } from 'react'

import { WrapperRunResultActions } from '../src/renderer/src/features/wrapper/components/WrapperRunResultActions'
import {
  wrapperResultBelongsToProject,
  wrapperResultRequestForUri,
  wrapperResultScopeChanged,
  wrapperResultScopeForOutput,
  wrapperResultScopeForPath,
  wrapperResultScopeForRun,
  wrapperResultUri,
  wrapperResultUriInScope
} from '../src/renderer/src/features/wrapper/lib/resultFiles'
import type { WrapperRun } from '../src/shared/wrapperTypes'

const run = {
  runId: 'wrun_a',
  outDir: '/scratch/results-a',
  remote: {
    projectId: 'project-a',
    hostProfileId: 'host-a',
    host: 'cluster-a',
    runDir: '/cluster/work/wrappers/runs/wrun_a',
    outputRoot: '/scratch/results-a'
  }
} as WrapperRun

test('result URIs preserve host and run identity while exposing only relative paths', () => {
  const scope = wrapperResultScopeForRun(run, 'output')!
  const uri = wrapperResultUri(scope, '/scratch/results-a/reports/summary.html')
  assert.equal(uri, 'ssh://cluster-a/scratch/results-a/reports/summary.html')
  assert.deepEqual(wrapperResultRequestForUri(uri, scope), {
    projectId: 'project-a',
    hostProfileId: 'host-a',
    runId: 'wrun_a',
    scope: 'output',
    path: 'reports/summary.html'
  })
  assert.equal(wrapperResultRequestForUri(wrapperResultUri(scope), scope).path, '')
  assert.equal(wrapperResultUriInScope(uri, scope), true)
  assert.equal(wrapperResultUriInScope('ssh://cluster-b/scratch/results-a/x', scope), false)
  assert.equal(wrapperResultUriInScope('ssh://cluster-a/scratch/results-a-other/x', scope), false)
  assert.throws(() => wrapperResultRequestForUri('ssh://cluster-a/etc/passwd', scope))
  assert.throws(() => wrapperResultUri(scope, '/etc/passwd'))
})

test('only saved primary remote output paths expose a report action', () => {
  const report = {
    id: 'report',
    path: '/scratch/results-a/reports/summary.html',
    exists: true,
    primary: true,
    location: 'remote' as const
  }
  assert.equal(wrapperResultScopeForOutput(run, report)?.scope, 'output')
  assert.equal(wrapperResultScopeForOutput(run, { ...report, location: 'local' }), null)
  assert.equal(wrapperResultScopeForOutput(run, { ...report, exists: false }), null)
  assert.equal(
    wrapperResultScopeForPath(run, '/cluster/work/wrappers/runs/wrun_a/logs/run.log')?.scope,
    'run'
  )
  assert.equal(wrapperResultScopeForPath(run, '/scratch/results-a-other/secret.txt'), null)
  assert.equal(wrapperResultScopeForRun({ ...run, remote: undefined }, 'output'), null)
})

test('changing project, host, run or scope invalidates the previous result preview', () => {
  const scope = wrapperResultScopeForRun(run, 'output')!
  assert.equal(wrapperResultScopeChanged(null, scope), true)
  assert.equal(wrapperResultScopeChanged(scope, { ...scope }), false)
  assert.equal(wrapperResultScopeChanged(scope, { ...scope, runId: 'wrun_b' }), true)
  assert.equal(wrapperResultScopeChanged(scope, { ...scope, projectId: 'project-b' }), true)
  assert.equal(wrapperResultScopeChanged(scope, { ...scope, hostProfileId: 'host-b' }), true)
  assert.equal(wrapperResultScopeChanged(scope, { ...scope, scope: 'run' }), true)
  assert.equal(wrapperResultBelongsToProject(scope, 'project-a'), true)
  assert.equal(wrapperResultBelongsToProject(scope, 'project-b'), false)
})

test('result buttons send the saved remote paths and never invoke local open', () => {
  const calls: Array<{ path: string; kind: string }> = []
  const withReport = {
    ...run,
    outputs: [
      {
        id: 'report',
        path: '/scratch/results-a/report.html',
        exists: true,
        primary: true,
        location: 'remote' as const
      }
    ]
  }
  const actions = WrapperRunResultActions({
    run: withReport,
    onOpenLocalPath: () => {
      throw new Error('remote result was sent to a local file action')
    },
    onOpenRemoteResult: (_run, path, kind) => calls.push({ path, kind })
  }) as ReactElement<{ children: unknown }>
  const items = Children.toArray(actions.props.children) as ReactElement[]
  const outputButton = (items[0].props as { children: ReactElement }).children.props
    .children as ReactElement<{ onClick: () => void }>
  const runButton = items[1] as ReactElement<{ onClick: () => void }>
  const reportButton = items[2] as ReactElement<{ onClick: () => void }>
  outputButton.props.onClick()
  runButton.props.onClick()
  reportButton.props.onClick()
  assert.deepEqual(calls, [
    { path: '/scratch/results-a', kind: 'directory' },
    { path: '/cluster/work/wrappers/runs/wrun_a', kind: 'directory' },
    { path: '/scratch/results-a/report.html', kind: 'file' }
  ])
})
