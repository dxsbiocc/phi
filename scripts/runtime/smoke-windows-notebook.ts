// Run on Windows x64 after fetching native micromamba. The smoke uses real
// bundled locks and a new runtime root for every invocation.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import {
  buildEnvironment,
  describeEnvironment
} from '../../src/main/agent/content/environment-refs'
import {
  currentPlatform,
  type EnsureProgressEvent,
  type EnvHandle
} from '../../src/main/agent/envs'
import {
  AnalysisNotebookExecutor,
  WebSocketJupyterKernelClient
} from '../../src/main/agent/notebook/analysis-jupyter-execution'
import { JupyterServerRegistry } from '../../src/main/agent/notebook/analysis-jupyter-server'
import {
  AnalysisNotebookSessionRegistry,
  FetchJupyterSessionClient
} from '../../src/main/agent/notebook/analysis-jupyter-sessions'
import {
  DEFAULT_KERNEL_NAME,
  listAnalysisKernels
} from '../../src/main/agent/notebook/analysis-kernels'
import { parseNotebook } from '../../src/shared/notebookDocument'

const environmentsDir = fileURLToPath(
  new URL('../../resources/runtime/environments', import.meta.url)
)
const SERVER_START_TIMEOUT_MS = 45_000
const KERNEL_EXECUTION_TIMEOUT_MS = 180_000

async function buildAndVerifyReuse(root: string, ref: string): Promise<EnvHandle> {
  const descriptor = describeEnvironment(ref, { environmentsDir })
  assert.equal(descriptor.platform, 'win32-x64', `${ref} must use its Windows lock`)
  assert.equal(descriptor.runtime, undefined, `${ref} must run natively`)

  const phases = new Set<EnsureProgressEvent['phase']>()
  const build = (): Promise<EnvHandle> =>
    buildEnvironment(root, descriptor, {
      onProgress(event) {
        phases.add(event.phase)
        console.log(`${ref} ${event.phase}: ${event.message}`)
      }
    })
  const handle = await build()
  assert.ok(phases.has('create'), `${ref} must be built from an empty prefix`)
  phases.clear()
  const reused = await build()
  assert.ok(!phases.has('create'), `${ref} unexpectedly rebuilt its ready prefix`)
  assert.equal(reused.envId, handle.envId)
  assert.equal(reused.metadata.createdAt, handle.metadata.createdAt)
  return handle
}

async function startServer(server: JupyterServerRegistry, cwd: string): Promise<void> {
  server.start(cwd)
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const status = server.status(cwd)
    if (status.state === 'ready' && status.hasEndpoint) return
    if (status.state !== 'starting') throw new Error(`Jupyter ${status.state}: ${status.message}`)
    await delay(250)
  }
  throw new Error(`Jupyter did not become ready: ${server.status(cwd).message}`)
}

async function runNotebook(root: string, cwd: string, python: EnvHandle): Promise<void> {
  const code = `
import os, sys
import numpy as np
import pandas as pd
import scanpy as sc
from anndata import AnnData

assert sys.platform == "win32", sys.platform
assert os.path.samefile(sys.prefix, ${JSON.stringify(python.prefix)}), sys.prefix
assert os.path.samefile(os.getcwd(), ${JSON.stringify(cwd)}), os.getcwd()
frame = pd.DataFrame([[1, 2], [3, 4]], dtype=np.float32)
adata = AnnData(frame.to_numpy())
sc.pp.normalize_total(adata, target_sum=10)
np.testing.assert_allclose(adata.X.sum(axis=1), [10, 10])
print("PHI_WINDOWS_NOTEBOOK_OK")
`
  const notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: 'smoke',
        cell_type: 'code',
        source: code,
        metadata: {},
        outputs: [],
        execution_count: null
      }
    ]
  }
  const notebookPath = join(cwd, '验证 笔记.ipynb')
  writeFileSync(notebookPath, JSON.stringify(notebook))
  const document = parseNotebook(notebook)
  const kernels = listAnalysisKernels({ root, environmentsDir, hostJupyterCommand: null })
  assert.ok(kernels.jupyterServer.available && kernels.jupyterServer.managed)
  assert.equal(kernels.preferredKernelName, DEFAULT_KERNEL_NAME)

  const server = new JupyterServerRegistry({
    managed: { root, environmentsDir },
    readyProbeAttempts: Math.ceil(SERVER_START_TIMEOUT_MS / 250),
    // A pre-existing server on the runner must not satisfy this test.
    identityProbe: async () => false
  })
  const sessions = new AnalysisNotebookSessionRegistry({
    getConnection: (projectCwd) => server.connection(projectCwd),
    client: new FetchJupyterSessionClient((url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
    )
  })
  try {
    await startServer(server, cwd)
    const status = await sessions.ensureSession({
      projectCwd: cwd,
      notebookPath,
      document,
      kernels
    })
    const target = sessions.executionTarget(cwd, notebookPath)
    assert.ok(target, status.message)
    assert.equal(target.kernelName, DEFAULT_KERNEL_NAME)
    const executor = new AnalysisNotebookExecutor({
      client: new WebSocketJupyterKernelClient({ executionTimeoutMs: KERNEL_EXECUTION_TIMEOUT_MS })
    })
    const result = await executor.executeCell({ ...target, cell: document.cells[0] })
    assert.equal(result.state, 'idle', JSON.stringify(result.outputs))
    const output = result.outputs.map((item) => item.text ?? '').join('')
    assert.match(output, /PHI_WINDOWS_NOTEBOOK_OK/)
    assert.equal((await sessions.closeSession(cwd, notebookPath)).state, 'disconnected')
    console.log(output.trim())
  } finally {
    try {
      await sessions.closeSession(cwd, notebookPath)
    } finally {
      server.disposeAll()
    }
  }
}

async function main(): Promise<void> {
  assert.equal(currentPlatform(), 'win32-x64', 'Run this smoke on a Windows x64 host')
  const base = mkdtempSync(join(tmpdir(), 'phi-'))
  const cwd = join(base, '实验 项目')
  const root = join(base, 'rt')
  try {
    mkdirSync(cwd)
    const python = await buildAndVerifyReuse(root, 'phi:python@1')
    await buildAndVerifyReuse(root, 'phi:jupyter@1')
    await runNotebook(root, cwd, python)
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
  }
}

await main()
