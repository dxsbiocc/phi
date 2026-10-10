import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { AnalysisNotebookExecutor } from '../src/main/agent/notebook/analysis-jupyter-execution'
import { AnalysisNotebookSessionRegistry } from '../src/main/agent/notebook/analysis-jupyter-sessions'
import {
  createNotebookWorkspace,
  MAX_NOTEBOOK_FILE_BYTES,
  type NotebookWorkspace,
  type NotebookWorkspaceWatchEvent
} from '../src/main/agent/notebook/notebook-workspace'
import { AnalysisNotebookToolExecutor } from '../src/main/agent/notebook/notebook-tool-executor'
import { LocalHost } from '../src/main/agent/workspace-host/local-host'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import type { WorkspaceHost } from '../src/main/agent/workspace-host/types'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import { updateNotebookCell } from '../src/shared/notebookDocument'
import { createLocalShellSession } from './helpers/localShellSession'

type Backend = {
  name: string
  create(root: string): Promise<{ host: WorkspaceHost; projectCwd: string }>
}

function execWithInput(command: string, input: string): Promise<RemoteExecResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('bash', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      resolveResult({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        code,
        signal
      })
    })
    child.stdin.end(input)
  })
}

function localShellSession(root: string): RemoteSshSession {
  const session = createLocalShellSession(root)
  session.execWithInput = execWithInput
  return session
}

const BACKENDS: Backend[] = [
  {
    name: 'LocalHost',
    create: async (root) => ({ host: new LocalHost(root), projectCwd: root })
  },
  {
    name: 'fake SshHost',
    create: async (root) => {
      const canonicalRoot = await realpath(root)
      const host = new SshHost({
        remoteRoot: root,
        canonicalRoot,
        connect: async () => localShellSession(canonicalRoot)
      })
      return { host, projectCwd: `/__phi_remote_${basename(root)}` }
    }
  }
]

function notebookBody(source = 'x = 1', spacing = 2): string {
  return JSON.stringify(
    {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { phi: { keep: true } },
      cells: [
        {
          id: 'cell-1',
          cell_type: 'code',
          execution_count: null,
          metadata: {},
          outputs: [],
          source
        }
      ]
    },
    null,
    spacing
  )
}

async function fixture(
  backend: Backend,
  run: (input: { root: string; host: WorkspaceHost; workspace: NotebookWorkspace }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'phi-notebook-workspace-'))
  let host: WorkspaceHost | undefined
  try {
    const created = await backend.create(root)
    host = created.host
    const workspace = createNotebookWorkspace({ projectCwd: created.projectCwd, host })
    await run({ root, host, workspace })
  } finally {
    await host?.close?.().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await delay(20)
  }
  assert.fail('timed out waiting for notebook watch event')
}

async function assertRevisionConflict(root: string, workspace: NotebookWorkspace): Promise<void> {
  const diskPath = join(root, 'notebooks', 'analysis.ipynb')
  await writeFile(diskPath, notebookBody())
  const opened = await workspace.open('notebooks/analysis.ipynb')
  await writeFile(diskPath, notebookBody('x = 1', 0))
  await assert.rejects(
    workspace.save({
      path: opened.path,
      document: updateNotebookCell(opened.document, 'cell-1', { source: 'x = 2' }),
      expectedRevision: opened.savedRevision,
      expectedHash: opened.contentHash
    }),
    /磁盘上变化/
  )
  assert.equal(await readFile(diskPath, 'utf8'), notebookBody('x = 1', 0))
}

async function assertAtomicRace(
  root: string,
  host: WorkspaceHost,
  workspace: NotebookWorkspace
): Promise<void> {
  const diskPath = join(root, 'notebooks', 'analysis.ipynb')
  const opened = await workspace.open('notebooks/analysis.ipynb')
  let race = true
  const racingHost: WorkspaceHost = {
    fs: {
      ...host.fs,
      writeAtomic: async (...args) => {
        if (race) {
          race = false
          await writeFile(diskPath, notebookBody('external race'))
        }
        return host.fs.writeAtomic(...args)
      }
    },
    exec: host.exec,
    capabilities: () => host.capabilities()
  }
  const racingWorkspace = createNotebookWorkspace({
    projectCwd: workspace.projectCwd,
    host: racingHost
  })
  await assert.rejects(
    racingWorkspace.save({
      path: opened.path,
      document: updateNotebookCell(opened.document, 'cell-1', { source: 'ours' }),
      expectedRevision: opened.savedRevision,
      expectedHash: opened.contentHash
    }),
    /磁盘上变化/
  )
  assert.match(await readFile(diskPath, 'utf8'), /external race/)
}

for (const backend of BACKENDS) {
  test(`${backend.name} notebook workspace lists, opens, creates, and deletes`, async () => {
    await fixture(backend, async ({ root, workspace }) => {
      await mkdir(join(root, 'notebooks'))
      await mkdir(join(root, 'outputs'))
      await mkdir(join(root, 'reports'))
      await mkdir(join(root, '.git'))
      await writeFile(join(root, 'notebooks', 'analysis.ipynb'), notebookBody())
      await writeFile(join(root, 'reports', 'summary.ipynb'), notebookBody('summary'))
      await writeFile(join(root, '.git', 'hidden.ipynb'), notebookBody('hidden'))

      const registry = await workspace.list()
      assert.equal(registry.initialized, true)
      assert.deepEqual(
        registry.notebooks.map((item) => item.relativePath),
        ['notebooks/analysis.ipynb', 'reports/summary.ipynb']
      )
      assert.ok(Number.isFinite(Date.parse(registry.notebooks[0].modifiedAt)))

      const opened = await workspace.open(resolve(workspace.projectCwd, 'notebooks/analysis.ipynb'))
      assert.equal(opened.document.cells[0].source, 'x = 1')
      assert.match(opened.contentHash ?? '', /^[a-f0-9]{64}$/)

      const saved = await workspace.save({
        path: opened.path,
        document: updateNotebookCell(opened.document, 'cell-1', { source: 'x = 2' }),
        expectedRevision: opened.savedRevision,
        expectedHash: opened.contentHash
      })
      assert.equal(saved.document.cells[0].source, 'x = 2')
      assert.match(await readFile(join(root, opened.relativePath), 'utf8'), /x = 2/)

      const created = await workspace.create()
      assert.equal(created.relativePath, 'notebooks/Untitled.ipynb')
      const deleted = await workspace.delete(created.path)
      assert.equal(deleted.relativePath, created.relativePath)
      await assert.rejects(access(join(root, created.relativePath)))

      if (backend.name === 'fake SshHost') {
        await assert.rejects(access(workspace.projectCwd))
      }
    })
  })

  test(`${backend.name} notebook workspace enforces boundaries and file limits`, async () => {
    await fixture(backend, async ({ root, workspace }) => {
      const outside = await mkdtemp(join(tmpdir(), 'phi-notebook-outside-'))
      try {
        await mkdir(join(root, 'notebooks'))
        await writeFile(join(outside, 'secret.ipynb'), notebookBody('secret'))
        await symlink(join(outside, 'secret.ipynb'), join(root, 'notebooks', 'escape.ipynb'))
        await symlink(outside, join(root, 'notebooks', 'escape-dir'))
        await writeFile(
          join(root, 'notebooks', 'large.ipynb'),
          Buffer.alloc(MAX_NOTEBOOK_FILE_BYTES + 1, 32)
        )

        await assert.rejects(workspace.open('notebooks/escape.ipynb'))
        await assert.rejects(workspace.create('notebooks/escape-dir/new.ipynb'))
        await assert.rejects(workspace.open('../secret.ipynb'), /当前项目内/)
        await assert.rejects(workspace.open('notebooks/not-a-notebook.txt'), /.ipynb/)
        await assert.rejects(workspace.open('notebooks/large.ipynb'), /1 MiB/)
        const listed = await workspace.list()
        assert.equal(
          listed.notebooks.some((item) => item.relativePath.includes('escape')),
          false
        )
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })

  test(`${backend.name} notebook workspace rejects revision and atomic hash conflicts`, async () => {
    await fixture(backend, async ({ root, host, workspace }) => {
      await mkdir(join(root, 'notebooks'))
      await assertRevisionConflict(root, workspace)
      await assertAtomicRace(root, host, workspace)
    })
  })

  test(`${backend.name} notebook workspace watch polls changes and stops after deletion`, async () => {
    await fixture(backend, async ({ root, workspace }) => {
      await mkdir(join(root, 'notebooks'))
      const diskPath = join(root, 'notebooks', 'analysis.ipynb')
      await writeFile(diskPath, notebookBody())
      const events: NotebookWorkspaceWatchEvent[] = []
      const subscription = await workspace.watch(
        'notebooks/analysis.ipynb',
        (event) => events.push(event),
        { pollIntervalMs: 10 }
      )
      await writeFile(diskPath, notebookBody('changed'))
      await waitFor(() => events.some((event) => event.type === 'changed'))
      await rm(diskPath)
      await waitFor(() => events.some((event) => event.type === 'deleted'))
      await delay(50)
      assert.deepEqual(
        events.map((event) => event.type),
        ['changed', 'deleted']
      )
      await subscription.close()
    })
  })
}

test('notebook workspace watch close waits for in-flight reads and suppresses late events', async () => {
  await fixture(BACKENDS[0], async ({ root, host, workspace }) => {
    await mkdir(join(root, 'notebooks'))
    await writeFile(join(root, 'notebooks', 'analysis.ipynb'), notebookBody())
    let releaseRead = (): void => undefined
    let markStarted = (): void => undefined
    const readReleased = new Promise<void>((resolveRead) => (releaseRead = resolveRead))
    const readStarted = new Promise<void>((resolveStarted) => (markStarted = resolveStarted))
    let blockNextRead = false
    const blockingHost: WorkspaceHost = {
      fs: {
        ...host.fs,
        readRange: async (...args) => {
          if (blockNextRead) {
            blockNextRead = false
            markStarted()
            await readReleased
          }
          return host.fs.readRange(...args)
        }
      },
      exec: host.exec,
      capabilities: () => host.capabilities()
    }
    const blockingWorkspace = createNotebookWorkspace({
      projectCwd: workspace.projectCwd,
      host: blockingHost
    })
    const events: NotebookWorkspaceWatchEvent[] = []
    const subscription = await blockingWorkspace.watch(
      'notebooks/analysis.ipynb',
      (event) => events.push(event),
      { pollIntervalMs: 10 }
    )
    blockNextRead = true
    await readStarted
    const closing = subscription.close()
    releaseRead()
    await closing
    assert.deepEqual(events, [])
  })
})

test('notebook workspace propagates host listing and stat failures', async () => {
  await fixture(BACKENDS[0], async ({ root, host, workspace }) => {
    const connectionError = new Error('host connection lost')
    const failingListHost: WorkspaceHost = {
      fs: { ...host.fs, list: async () => Promise.reject(connectionError) },
      exec: host.exec,
      capabilities: () => host.capabilities()
    }
    await assert.rejects(
      createNotebookWorkspace({ projectCwd: workspace.projectCwd, host: failingListHost }).list(),
      /connection lost/
    )

    await mkdir(join(root, 'notebooks'))
    await writeFile(join(root, 'notebooks', 'analysis.ipynb'), notebookBody())
    const failingStatHost: WorkspaceHost = {
      fs: {
        ...host.fs,
        stat: async (path, options) => {
          if (path.endsWith('.ipynb')) throw connectionError
          return host.fs.stat(path, options)
        }
      },
      exec: host.exec,
      capabilities: () => host.capabilities()
    }
    await assert.rejects(
      createNotebookWorkspace({ projectCwd: workspace.projectCwd, host: failingStatHost }).list(),
      /connection lost/
    )
  })
})

test('notebook tool executor uses an injected host workspace without local anchor access', async () => {
  await fixture(BACKENDS[1], async ({ root, workspace }) => {
    await mkdir(join(root, 'notebooks'))
    await writeFile(join(root, 'notebooks', 'analysis.ipynb'), notebookBody())
    const executor = new AnalysisNotebookToolExecutor({
      resolveWorkspaceByCwd: (cwd) =>
        cwd === workspace.projectCwd ? { workingDirectory: workspace.projectCwd } : null,
      resolveNotebookWorkspaceByCwd: (cwd) => (cwd === workspace.projectCwd ? workspace : null),
      ensureJupyterServerReady: async () => undefined,
      notebookSessionRegistry: new AnalysisNotebookSessionRegistry({ getConnection: () => null }),
      notebookExecutor: new AnalysisNotebookExecutor()
    })

    const listed = await executor.execute({ action: 'list', cwd: workspace.projectCwd, params: {} })
    assert.equal((listed.notebooks as unknown[]).length, 1)
    const opened = await executor.execute({
      action: 'read',
      cwd: workspace.projectCwd,
      params: { path: 'notebooks/analysis.ipynb' }
    })
    assert.equal(opened.path, resolve(workspace.projectCwd, 'notebooks/analysis.ipynb'))
    await assert.rejects(access(workspace.projectCwd))
  })
})
