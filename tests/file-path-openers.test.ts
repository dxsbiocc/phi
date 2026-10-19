import assert from 'node:assert/strict'
import test from 'node:test'

import {
  openDefaultPreviewPath,
  openFilePreview,
  openLocalPath,
  openWorkspaceFileFromSidebar,
  openWrapperResult,
  previewFileInWorkspaceTab,
  type PathOpenerTargets
} from '../src/renderer/src/features/file-preview/lib/pathOpeners'
import type { WrapperResultFileScope } from '../src/renderer/src/features/wrapper/lib/resultFiles'

const remoteScope = { hostAlias: 'cluster', canonicalRoot: '/work' }
const wrapperScope: WrapperResultFileScope = {
  projectId: 'p1',
  hostProfileId: 'h1',
  runId: 'r1',
  hostAlias: 'cluster',
  scope: 'run',
  root: '/work/r1'
}

type Calls = {
  layout: number
  tabs: string[]
  files: string[]
  directories: string[]
  system: string[]
  notebooks: string[]
  errors: Array<{ fallback: string }>
  wrapper: string[]
}

/** Recording surfaces: the router decides, these note what it decided. */
function recorder(overrides: Partial<PathOpenerTargets> = {}): {
  targets: PathOpenerTargets
  calls: Calls
} {
  const calls: Calls = {
    layout: 0,
    tabs: [],
    files: [],
    directories: [],
    system: [],
    notebooks: [],
    errors: [],
    wrapper: []
  }
  const targets: PathOpenerTargets = {
    applyLayout: () => {
      calls.layout += 1
    },
    getActiveCwd: () => '/project',
    setActiveTabKey: (key) => calls.tabs.push(key),
    previewFile: (path) => calls.files.push(path),
    previewDirectory: (path) => calls.directories.push(path),
    openSystemDefault: (path) => calls.system.push(path),
    isRemoteProject: () => false,
    getActiveProjectId: () => 'p1',
    getRemoteScope: () => null,
    blockLocalInRemote: () => false,
    notifyError: (_error, fallback) => calls.errors.push({ fallback }),
    openNotebook: (path) => calls.notebooks.push(path),
    wrapper: {
      scope: null,
      isActiveUri: () => false,
      openPath: (_scope, path) => {
        calls.wrapper.push(path)
        return `ssh://cluster${path}`
      }
    },
    ...overrides
  }
  return { targets, calls }
}

test('a local notebook goes to the analysis workspace, not the file preview', () => {
  const { targets, calls } = recorder()
  openLocalPath(targets, '/project/notebooks/01.ipynb', 'file')
  assert.deepEqual(calls.notebooks, ['/project/notebooks/01.ipynb'])
  assert.deepEqual(calls.files, [])
  assert.deepEqual(calls.tabs, [])
})

test('a directory opens the preview directory and its workspace tab', () => {
  const { targets, calls } = recorder()
  openLocalPath(targets, '/project/data', 'directory')
  assert.deepEqual(calls.directories, ['/project/data'])
  assert.deepEqual(calls.tabs, ['file:/project/data'])
  assert.deepEqual(calls.files, [])
})

test('an ordinary local file opens the preview and the workspace tab', () => {
  const { targets, calls } = recorder()
  openLocalPath(targets, '/project/data/qc.tsv', 'file')
  assert.deepEqual(calls.files, ['/project/data/qc.tsv'])
  assert.deepEqual(calls.tabs, ['file:/project/data/qc.tsv'])
  assert.equal(calls.layout, 1)
})

test('a remote project refuses a path outside its canonical root instead of reading locally', () => {
  const { targets, calls } = recorder({
    isRemoteProject: () => true,
    getRemoteScope: () => remoteScope
  })
  openLocalPath(targets, '/etc/passwd', 'file')
  assert.equal(calls.errors.length, 1)
  assert.deepEqual(calls.files, [])
  assert.deepEqual(calls.directories, [])
  assert.equal(calls.layout, 0)
})

test('a remote file inside the project opens through its ssh uri', () => {
  const { targets, calls } = recorder({
    isRemoteProject: () => true,
    getRemoteScope: () => remoteScope
  })
  openLocalPath(targets, '/work/results/out.tsv', 'file')
  assert.equal(calls.files.length, 1)
  assert.ok(calls.files[0].startsWith('ssh://cluster/'))
  assert.deepEqual(calls.system, [])
})

test('a remote notebook hands its server path to the analysis workspace', () => {
  const { targets, calls } = recorder({
    isRemoteProject: () => true,
    getRemoteScope: () => remoteScope
  })
  openLocalPath(targets, '/work/notebooks/qc.ipynb', 'file')
  assert.deepEqual(calls.notebooks, ['/work/notebooks/qc.ipynb'])
  assert.deepEqual(calls.files, [])
})

test('a blocked local path opens nothing and reports nothing', () => {
  const { targets, calls } = recorder({ blockLocalInRemote: () => true })
  openLocalPath(targets, '/project/data/qc.tsv', 'file')
  assert.deepEqual(calls.files, [])
  assert.deepEqual(calls.tabs, [])
  assert.equal(calls.layout, 0)
  assert.equal(calls.errors.length, 0)
})

test('a wrapper result of the active project wins over the notebook hand-off', () => {
  const { targets, calls } = recorder({
    wrapper: {
      scope: wrapperScope,
      isActiveUri: () => true,
      openPath: () => {
        throw new Error('the active result path is opened directly, not through openPath')
      }
    }
  })
  openLocalPath(targets, 'ssh://cluster/work/r1/report.ipynb', 'file')
  assert.deepEqual(calls.files, ['ssh://cluster/work/r1/report.ipynb'])
  assert.deepEqual(calls.notebooks, [])
  assert.deepEqual(calls.tabs, ['file:ssh://cluster/work/r1/report.ipynb'])
})

test('a wrapper result from another project does not hijack an ordinary file', () => {
  const { targets, calls } = recorder({
    getActiveProjectId: () => 'p2',
    wrapper: {
      scope: wrapperScope,
      isActiveUri: () => true,
      openPath: () => {
        throw new Error('another project’s result must not open')
      }
    }
  })
  openLocalPath(targets, '/project/data/qc.tsv', 'file')
  assert.deepEqual(calls.files, ['/project/data/qc.tsv'])
})

test('the system default is only used for non-notebook paths', () => {
  const plain = recorder()
  openDefaultPreviewPath(plain.targets, '/project/report.pdf')
  assert.deepEqual(plain.calls.system, ['/project/report.pdf'])

  const notebook = recorder()
  openDefaultPreviewPath(notebook.targets, '/project/notebooks/01.ipynb')
  assert.deepEqual(notebook.calls.system, [])
  assert.deepEqual(notebook.calls.notebooks, ['/project/notebooks/01.ipynb'])
})

test('the sidebar and preview-panel entry points share the same notebook hand-off', () => {
  const fromSidebar = recorder()
  openWorkspaceFileFromSidebar(fromSidebar.targets, '/project/notebooks/01.ipynb')
  assert.deepEqual(fromSidebar.calls.notebooks, ['/project/notebooks/01.ipynb'])
  assert.deepEqual(fromSidebar.calls.files, [])

  const fromPanel = recorder()
  openFilePreview(fromPanel.targets, '/project/notebooks/01.ipynb')
  assert.deepEqual(fromPanel.calls.notebooks, ['/project/notebooks/01.ipynb'])
  assert.deepEqual(fromPanel.calls.files, [])
})

test('opening a Wrapper run result refuses an inactive project and reports it', () => {
  const { targets, calls } = recorder({ getActiveProjectId: () => 'another-project' })
  openWrapperResult(
    targets,
    {
      id: 'run-1',
      remote: { projectId: 'p1' }
    } as never,
    '/work/r1/report.html',
    'file'
  )
  assert.equal(calls.errors.length, 1)
  assert.equal(calls.errors[0].fallback.length > 0, true)
  assert.deepEqual(calls.wrapper, [])
})

test('a relative path is normalized for the tab key but previewed as given', () => {
  const { targets, calls } = recorder()
  previewFileInWorkspaceTab(targets, 'data/qc.tsv')
  assert.deepEqual(calls.tabs, ['file:/project/data/qc.tsv'])
  assert.deepEqual(calls.files, ['data/qc.tsv'])
})
