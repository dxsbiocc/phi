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
  FetchJupyterSessionClient,
  type AnalysisNotebookSessionStatus,
  type EnsureNotebookSessionInput
} from '../../src/main/agent/notebook/analysis-jupyter-sessions'
import {
  DEFAULT_KERNEL_NAME,
  listAnalysisKernels
} from '../../src/main/agent/notebook/analysis-kernels'
import { parseNotebook } from '../../src/shared/notebookDocument'
import { safeDiagnosticText } from './windows-notebook-smoke-diagnostics'

const environmentsDir = fileURLToPath(
  new URL('../../resources/runtime/environments', import.meta.url)
)
const SERVER_START_TIMEOUT_MS = 45_000
const KERNEL_EXECUTION_TIMEOUT_MS = 180_000
const SMOKE_STARTED_AT_MS = Date.now()
const MAX_DIAGNOSTIC_FETCH_FAILURES = 5
const MAX_DIAGNOSTIC_LOG_LINES = 20

interface TimelineEvent {
  atMs: number
  event: string
}

interface NetworkErrorObservation {
  name?: string
  message: string
  code?: string | number
  errno?: string | number
  syscall?: string
  address?: string
  port?: number
  cause?: NetworkErrorObservation
  errors?: NetworkErrorObservation[]
}

interface FetchFailureObservation {
  atMs: number
  stage: string
  method: string
  endpoint: string
  error: NetworkErrorObservation
}

interface RunDiagnostics {
  stage: string
  timeline: TimelineEvent[]
  fetchFailureCount: number
  fetchFailures: FetchFailureObservation[]
}

function elapsedMs(): number {
  return Date.now() - SMOKE_STARTED_AT_MS
}

function observeNetworkError(value: unknown, depth = 0): NetworkErrorObservation {
  if (!value || typeof value !== 'object') return { message: safeDiagnosticText(value) }
  const record = value as Record<string, unknown>
  const observation: NetworkErrorObservation = {
    message: safeDiagnosticText(record.message ?? value)
  }
  if (typeof record.name === 'string') observation.name = safeDiagnosticText(record.name, 100)
  if (typeof record.code === 'string') {
    observation.code = safeDiagnosticText(record.code, 100)
  } else if (typeof record.code === 'number') {
    observation.code = record.code
  }
  if (typeof record.errno === 'string') {
    observation.errno = safeDiagnosticText(record.errno, 100)
  } else if (typeof record.errno === 'number') {
    observation.errno = record.errno
  }
  if (typeof record.syscall === 'string')
    observation.syscall = safeDiagnosticText(record.syscall, 100)
  if (typeof record.address === 'string')
    observation.address = safeDiagnosticText(record.address, 200)
  if (typeof record.port === 'number') {
    observation.port = record.port
  } else if (typeof record.port === 'string' && /^\d+$/.test(record.port)) {
    observation.port = Number(record.port)
  }
  if (depth < 3 && record.cause !== undefined) {
    observation.cause = observeNetworkError(record.cause, depth + 1)
  }
  if (depth < 3 && Array.isArray(record.errors)) {
    observation.errors = record.errors
      .slice(0, 3)
      .map((nested) => observeNetworkError(nested, depth + 1))
  }
  return observation
}

function markDiagnosticStage(diagnostics: RunDiagnostics, stage: string): void {
  diagnostics.stage = stage
  diagnostics.timeline.push({ atMs: elapsedMs(), event: stage })
  if (diagnostics.timeline.length > 50) diagnostics.timeline.shift()
}

function instrumentedFetch(diagnostics: RunDiagnostics): typeof fetch {
  return async (input, init) => {
    const method = safeDiagnosticText(
      (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      20
    )
    let endpoint = '<unparseable>'
    try {
      const url = input instanceof Request ? new URL(input.url) : new URL(input)
      // Query strings can carry tokens; record only the origin and path.
      endpoint = safeDiagnosticText(`${url.origin}${url.pathname}`)
    } catch {
      // The request never reached the server; an unknown URL is still reportable.
    }
    try {
      return await fetch(input, { ...init, signal: AbortSignal.timeout(20_000) })
    } catch (error) {
      diagnostics.fetchFailureCount += 1
      if (diagnostics.fetchFailures.length < MAX_DIAGNOSTIC_FETCH_FAILURES) {
        diagnostics.fetchFailures.push({
          atMs: elapsedMs(),
          stage: diagnostics.stage,
          method,
          endpoint,
          error: observeNetworkError(error)
        })
      }
      throw error
    }
  }
}

function boundedServerLogs(server: JupyterServerRegistry, projectCwd: string): string[] {
  // The public status intentionally omits logs. The registry keeps only a bounded,
  // sanitized tail, so read it for failure diagnostics without widening the product API.
  const records = (server as unknown as { records?: unknown }).records
  if (!(records instanceof Map)) return []
  const record = records.get(projectCwd) as { logs?: unknown } | undefined
  if (!Array.isArray(record?.logs)) return []
  return record.logs
    .filter((line): line is string => typeof line === 'string')
    .slice(-MAX_DIAGNOSTIC_LOG_LINES)
    .map((line) => safeDiagnosticText(line))
}

function safeStatusMessage<T extends { message?: string }>(status: T): T {
  if (!status.message) return status
  return { ...status, message: safeDiagnosticText(status.message) }
}

function printFailureDiagnostics(input: {
  diagnostics: RunDiagnostics
  failure: unknown
  server: JupyterServerRegistry
  sessions: AnalysisNotebookSessionRegistry
  sessionInput?: EnsureNotebookSessionInput
  ensureStatus?: AnalysisNotebookSessionStatus
  cwd: string
}): void {
  const report: Record<string, unknown> = {
    observation: 'failure-time diagnostics only; these are observations, not a root cause',
    redaction: 'request query/headers/body and token/authorization/cookie values are omitted',
    failedStage: input.diagnostics.stage,
    failure: observeNetworkError(input.failure),
    timeline: input.diagnostics.timeline,
    fetchFailureCount: input.diagnostics.fetchFailureCount,
    fetchFailures: input.diagnostics.fetchFailures
  }
  if (input.ensureStatus) {
    // The exact value returned by ensureSession; the registry does not retain error records.
    report.sessionEnsureResult = safeStatusMessage(input.ensureStatus)
  }
  try {
    const serverStatus = input.server.status(input.cwd)
    report.server = safeStatusMessage(serverStatus)
    report.serverLogsSanitized = boundedServerLogs(input.server, serverStatus.projectCwd)
  } catch (error) {
    report.serverStatusError = safeDiagnosticText(error)
  }
  if (input.sessionInput) {
    try {
      report.session = safeStatusMessage(input.sessions.status(input.sessionInput))
    } catch (error) {
      report.sessionStatusError = safeDiagnosticText(error)
    }
  }
  console.error('[smoke] failure diagnostics (observations only; no root cause inferred)')
  console.error(JSON.stringify(report, null, 2))
}

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
adata = AnnData(frame.to_numpy(copy=True))
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

  const diagnostics: RunDiagnostics = {
    stage: 'notebook:enter',
    timeline: [{ atMs: elapsedMs(), event: 'notebook:enter' }],
    fetchFailureCount: 0,
    fetchFailures: []
  }
  const mark = (stage: string): void => markDiagnosticStage(diagnostics, stage)
  const server = new JupyterServerRegistry({
    managed: { root, environmentsDir },
    readyProbeAttempts: Math.ceil(SERVER_START_TIMEOUT_MS / 250),
    // A pre-existing server on the runner must not satisfy this test.
    identityProbe: async () => false
  })
  const sessions = new AnalysisNotebookSessionRegistry({
    getConnection: (projectCwd) => server.connection(projectCwd),
    client: new FetchJupyterSessionClient(instrumentedFetch(diagnostics))
  })
  const sessionInput: EnsureNotebookSessionInput = {
    projectCwd: cwd,
    notebookPath,
    document,
    kernels
  }
  let failed = false
  let failure: unknown
  let ensureStatus: AnalysisNotebookSessionStatus | undefined
  try {
    mark('notebook:server-start')
    await startServer(server, cwd)
    mark('notebook:server-ready')
    mark('notebook:session-ensure')
    const status = await sessions.ensureSession(sessionInput)
    ensureStatus = status
    mark('notebook:session-ensured')
    mark('notebook:execution-target')
    const target = sessions.executionTarget(cwd, notebookPath)
    assert.ok(target, status.message)
    assert.equal(target.kernelName, DEFAULT_KERNEL_NAME)
    const executor = new AnalysisNotebookExecutor({
      client: new WebSocketJupyterKernelClient({ executionTimeoutMs: KERNEL_EXECUTION_TIMEOUT_MS })
    })
    mark('notebook:execute-cell')
    const result = await executor.executeCell({ ...target, cell: document.cells[0] })
    assert.equal(result.state, 'idle', JSON.stringify(result.outputs))
    const output = result.outputs.map((item) => item.text ?? '').join('')
    assert.match(output, /PHI_WINDOWS_NOTEBOOK_OK/)
    mark('notebook:close-session')
    assert.equal((await sessions.closeSession(cwd, notebookPath)).state, 'disconnected')
    console.log(output.trim())
  } catch (error) {
    failed = true
    failure = error
    throw error
  } finally {
    if (failed) {
      try {
        printFailureDiagnostics({
          diagnostics,
          failure,
          server,
          sessions,
          sessionInput,
          ensureStatus,
          cwd
        })
      } catch (error) {
        console.error(
          `[smoke] failure diagnostics could not be printed: ${safeDiagnosticText(error)}`
        )
      }
    }
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
