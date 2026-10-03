// Integration (PHI_RUNTIME_INTEGRATION=1): build phi-jupyter and a Python kernel environment
// from their locks, start the managed server, run `1+1` in the managed kernel, shut down.
//
// The kernel environment is `tests/fixtures/envs/ipykernel` (python=3.12 + ipykernel) served
// as `phi:python@1`; the real phi-python spec is too large to build inside the test timeout
// on a cold package cache.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'

import { buildEnvironment, describeEnvironment } from '../src/main/agent/content/environment-refs'
import { currentPlatform, removeTree } from '../src/main/agent/envs'
import { getMicromambaPath } from '../src/main/agent/envs/paths'
import { AnalysisNotebookExecutor } from '../src/main/agent/notebook/analysis-jupyter-execution'
import { JupyterServerRegistry } from '../src/main/agent/notebook/analysis-jupyter-server'
import { AnalysisNotebookSessionRegistry } from '../src/main/agent/notebook/analysis-jupyter-sessions'
import { listAnalysisKernels } from '../src/main/agent/notebook/analysis-kernels'
import type { NotebookCell, NotebookDocument } from '../src/shared/notebookDocument'
import { createTestRuntimeRoot } from './helpers/testRuntimeRoot'

function integrationSkipReason(): string | false {
  if (process.env.PHI_RUNTIME_INTEGRATION !== '1') {
    return 'network integration: set PHI_RUNTIME_INTEGRATION=1 (npm run test:runtime)'
  }
  if (process.env.PHI_OFFLINE === '1') return 'PHI_OFFLINE=1; integration tests skipped'
  try {
    getMicromambaPath()
    return false
  } catch (error) {
    const message = error instanceof Error ? error.message : 'bundled micromamba is unavailable'
    return `${message}; integration tests skipped`
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function waitReady(registry: JupyterServerRegistry, project: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const status = registry.status(project)
    if (status.state === 'ready' && status.hasEndpoint) return
    if (status.state === 'error' || status.state === 'exited') {
      throw new Error(`Jupyter Server ${status.state}: ${status.message ?? ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Jupyter Server did not become ready')
}

const CELL = {
  id: 'c1',
  cellType: 'code',
  source: '1+1',
  outputs: [],
  executionCount: null,
  metadata: {}
} as unknown as NotebookCell

test(
  'integration: managed Jupyter server runs 1+1 in the managed Python kernel',
  { timeout: 1_200_000, skip: integrationSkipReason() },
  async () => {
    const root = createTestRuntimeRoot('managed-jupyter')
    try {
      const runtimeRoot = realpathSync(root)
      const platform = currentPlatform()
      const environmentsDir = join(runtimeRoot, 'environments')
      const project = join(runtimeRoot, 'project')
      mkdirSync(project, { recursive: true })
      cpSync(
        join(process.cwd(), 'resources/runtime/environments/phi-jupyter'),
        join(environmentsDir, 'phi-jupyter'),
        { recursive: true }
      )
      cpSync(
        join(process.cwd(), 'tests/fixtures/envs/ipykernel'),
        join(environmentsDir, 'phi-python'),
        { recursive: true }
      )
      cpSync(
        join(process.cwd(), 'resources/runtime/environments/phi-r'),
        join(environmentsDir, 'phi-r'),
        { recursive: true }
      )
      for (const ref of ['phi:jupyter@1', 'phi:python@1']) {
        await buildEnvironment(runtimeRoot, describeEnvironment(ref, { environmentsDir, platform }))
      }

      const context = { root: runtimeRoot, environmentsDir, platform }
      const kernels = listAnalysisKernels({ ...context, hostJupyterCommand: null })
      assert.equal(kernels.jupyterServer.available, true)
      assert.equal(kernels.preferredKernelName, 'phi-python')
      assert.deepEqual(
        kernels.kernels.map((kernel) => [kernel.name, kernel.status]),
        [
          ['phi-python', 'ready'],
          ['phi-r', 'not-built']
        ]
      )

      const server = new JupyterServerRegistry({ managed: context, port: await freePort() })
      const sessions = new AnalysisNotebookSessionRegistry({
        getConnection: (cwd) => server.connection(cwd)
      })
      try {
        server.start(project)
        await waitReady(server, project)
        const notebookPath = join(project, 'check.ipynb')
        const document = {
          cells: [CELL],
          metadata: {},
          nbformat: 4,
          nbformatMinor: 5
        } as unknown as NotebookDocument
        const session = await sessions.ensureSession({
          projectCwd: project,
          notebookPath,
          document,
          kernels
        })
        assert.equal(session.kernelName, 'phi-python', session.message)
        const target = sessions.executionTarget(project, notebookPath)
        assert.ok(target, session.message)
        const executed = await new AnalysisNotebookExecutor().executeCell({
          connection: target.connection,
          sessionId: target.sessionId,
          kernelId: target.kernelId,
          cell: CELL
        })
        assert.equal(executed.state, 'idle')
        const result = executed.outputs.find((output) => output.outputType === 'execute_result')
        assert.deepEqual(
          (result as { data?: Record<string, unknown> } | undefined)?.data?.['text/plain'],
          '2'
        )
        await sessions.closeSession(project, notebookPath)
      } finally {
        server.disposeAll()
        // Let the server shut its kernels down before the runtime root is removed.
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
    } finally {
      removeTree(root)
    }
  }
)
