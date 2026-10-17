import assert from 'node:assert/strict'

import { redactSensitiveText } from '../../src/main/agent/redaction'
import { shellQuote } from '../../src/main/agent/wrappers/remote-ssh-session'
import { runR8Cases } from './scenarios'
import { bounded, DEFAULT_PREPARE_MINUTES } from './types'
import type { R8Application } from './application-types'
import type { R8Workspace } from './workspace'

export interface R8RunIdentity {
  readonly runId: string
  readonly host: string
  readonly runtimeRootConfigured: string
  readonly bundleHash: string
}

export interface R8RunDependencies {
  readonly identity: R8RunIdentity
  /** Recomputes the bundle hash the way production does; must equal the recorded one. */
  currentBundleHash(): Promise<string>
  openWorkspace(signal: AbortSignal): Promise<R8Workspace>
  createApplication(workspace: R8Workspace): Promise<R8Application>
  /** Bound of the prepare phase; defaults to 15 minutes. */
  readonly prepareMs?: number
}

export interface CleanupRecord {
  applicationClosed: boolean
  rpcClosed: boolean
  generationDirectoriesRemoved: boolean
  tunnelsClosed: boolean
  ownedTestRootRemoved: boolean
  transportsClosed: boolean
  failures: Array<{ name: string; reason: string }>
}

/** Steps whose duration reveals an install or repair on the server (reuse takes a few commands). */
const INSTALL_STEPS = ['runtime_binary', 'extension_deployment', 'remote_helper'] as const
const INSTALL_THRESHOLD_MS = 3000

export interface PrepareRecord {
  status: 'ready' | 'failed' | 'unknown'
  /** Wall time of the whole phase, including session creation and disposal. */
  elapsedMs: number
  startupMs: number | null
  remoteCommands: number
  steps: unknown[]
  /** Heuristic from the startup steps; the local download is in the receipt's `assetCache`. */
  installedOrRepaired: boolean
  installEvidence: string[]
}

export interface R8RunResult {
  runId: string
  host: string
  runtimeRootConfigured: string
  runtimeRoot?: string
  runtimeRootCreated?: boolean
  projectRoot?: string
  bundleHash: string
  ompVersion?: string
  ok: boolean
  failedPhase?: string
  failureKind?: string
  failureReason?: string
  cases: Record<string, unknown>[]
  providerRequests?: number
  providerPurposes?: { root: number; child: number; summary: number }
  rpcGenerations?: number
  tunnels?: { opened: number; closed: number }
  prepare?: PrepareRecord
  startup: Array<Record<string, unknown>>
  remoteOperations?: Array<{ kind: string; elapsedMs: number }>
  rpcStartup?: Array<{ nonce: string | null; stdioOpenToAttestationMs: number | null }>
  cleanup: CleanupRecord
  elapsedMs: number
}

/** One real production startup, disposed again: it installs whatever the server lacks. */
async function prepareHost(
  result: R8RunResult,
  app: R8Application,
  prepareMs: number
): Promise<void> {
  const at = performance.now()
  try {
    await bounded(app.prepare(), prepareMs, 'prepare (host installation startup)')
  } finally {
    result.prepare = prepareRecord(app.startupReports[0], performance.now() - at)
  }
}

function prepareRecord(
  report: R8Application['startupReports'][number] | undefined,
  elapsedMs: number
): PrepareRecord {
  const steps = report?.steps ?? []
  const evidence = steps
    .filter((step) => INSTALL_STEPS.some((name) => name === step.step))
    .filter((step) => step.durationMs >= INSTALL_THRESHOLD_MS)
    .map((step) => `${step.step} took ${(step.durationMs / 1000).toFixed(1)}s`)
  return {
    status: report?.status ?? 'unknown',
    elapsedMs,
    startupMs: report?.totalMs ?? null,
    remoteCommands: steps.reduce((total, step) => total + step.remoteCommands, 0),
    steps: [...steps],
    installedOrRepaired: evidence.length > 0,
    installEvidence: evidence
  }
}

function describe(error: unknown): { name: string; reason: string } {
  return {
    name: error instanceof Error ? error.name : 'UNKNOWN',
    reason: redactSensitiveText(error instanceof Error ? error.message : 'Unknown failure')
  }
}

/**
 * The orchestration shared by the real SSH run and the local-shell test: open the owned
 * workspace, build the application, run the cases, then clean up through production APIs.
 * Cleanup always runs; the original failure stays primary and cleanup failures are recorded.
 */
export async function executeR8(
  deps: R8RunDependencies,
  controller: AbortController
): Promise<R8RunResult> {
  const { identity } = deps
  const started = performance.now()
  const result: R8RunResult = {
    runId: identity.runId,
    host: identity.host,
    runtimeRootConfigured: identity.runtimeRootConfigured,
    bundleHash: identity.bundleHash,
    ok: false,
    cases: [],
    startup: [],
    cleanup: {
      applicationClosed: false,
      rpcClosed: false,
      generationDirectoriesRemoved: false,
      tunnelsClosed: false,
      ownedTestRootRemoved: false,
      transportsClosed: false,
      failures: []
    },
    elapsedMs: 0
  }
  let phase = 'bundle'
  let workspace: R8Workspace | undefined
  let app: R8Application | undefined
  let primary: unknown
  const log = (value: string): void => {
    phase = value
    console.log(JSON.stringify({ type: 'r8_phase', runId: identity.runId, phase }))
  }
  try {
    assert.equal(
      await deps.currentBundleHash(),
      identity.bundleHash,
      'Extension bundle differs from the recorded hash'
    )
    log('owned-remote-workspace')
    workspace = await deps.openWorkspace(controller.signal)
    result.runtimeRoot = workspace.runtimeRoot
    result.runtimeRootCreated = workspace.rootCreated
    result.projectRoot = workspace.projectRoot
    log('application-runtime')
    app = await deps.createApplication(workspace)
    result.ompVersion = app.ompVersion
    log('prepare')
    await prepareHost(result, app, deps.prepareMs ?? DEFAULT_PREPARE_MINUTES * 60_000)
    log('cases')
    result.cases = await runR8Cases(identity.runId, workspace, app)
    assert.equal(app.provider.requests.length, 12)
    assert.deepEqual(app.purposes, { root: 10, child: 2, summary: 0 })
    result.providerRequests = app.provider.requests.length
    result.providerPurposes = { ...app.purposes }
    controller.signal.throwIfAborted()
    result.ok = true
  } catch (error) {
    primary = error
    result.ok = false
    result.failedPhase = phase
    result.failureKind = controller.signal.aborted
      ? 'CANCELLED'
      : error instanceof Error
        ? error.name
        : 'UNKNOWN'
    result.failureReason = describe(error).reason
  }

  log('cleanup')
  const failures = result.cleanup.failures
  const attempt = async <T>(label: string, work: () => Promise<T>): Promise<boolean> => {
    try {
      await work()
      return true
    } catch (error) {
      failures.push({ ...describe(error), name: `${label}: ${describe(error).name}` })
      return false
    }
  }
  const setupUnconfirmed = phase === 'owned-remote-workspace' && !workspace
  if (app)
    result.cleanup.applicationClosed = await attempt('application close', () =>
      bounded(app!.close(), 30_000, 'application cleanup')
    )
  else result.cleanup.applicationClosed = true
  if (workspace) {
    const remote = workspace
    const closedForRemoval = result.cleanup.applicationClosed || !remote.hasOpenChannels()
    result.cleanup.rpcClosed = closedForRemoval
      ? await attempt('rpc close', () => bounded(remote.awaitRpcClosed(), 30_000, 'rpc close'))
      : false
    if (result.cleanup.rpcClosed) {
      result.cleanup.generationDirectoriesRemoved = await attempt('generation directories', () =>
        bounded(
          (async () => {
            for (const nonce of remote.generations)
              assert.match(
                await remote.command(
                  `[ ! -e ${shellQuote(`${remote.runtimeRoot}/rpc-sessions/${nonce}`)} ] && printf 'REMOVED\\n'`
                ),
                /^REMOVED/,
                'An attested rpc-sessions directory still exists'
              )
          })(),
          30_000,
          'generation directory audit'
        )
      )
      result.cleanup.ownedTestRootRemoved = await attempt('owned test tree', () =>
        bounded(remote.cleanupOwnedWork(), 30_000, 'owned test tree cleanup')
      )
    }
    result.cleanup.tunnelsClosed = await attempt('tunnels', async () => {
      const counts = await remote.tunnelCounts()
      result.tunnels = counts
      if (result.ok)
        assert.ok(counts.opened >= 3, 'The reverse model tunnel must be used by every startup')
      assert.equal(counts.closed, counts.opened, 'Every reverse tunnel must be closed')
    })
    result.cleanup.transportsClosed = await attempt('transports', () =>
      bounded(remote.close(), 30_000, 'transport cleanup')
    )
    result.rpcGenerations = remote.generations.length
    result.remoteOperations = remote.metrics.slice()
    result.rpcStartup = remote.rpc.map(({ openedAt, attestedAt, nonce }) => ({
      nonce: nonce ?? null,
      stdioOpenToAttestationMs: attestedAt === undefined ? null : attestedAt - openedAt
    }))
  } else {
    result.cleanup.rpcClosed = true
    result.cleanup.generationDirectoriesRemoved = true
    result.cleanup.tunnelsClosed = true
    result.cleanup.ownedTestRootRemoved = !setupUnconfirmed
    result.cleanup.transportsClosed = !setupUnconfirmed
  }
  if (app) {
    // The prepare startup is reported on its own; the cases' startups are create, then resume.
    const [, ...caseReports] = app.startupReports
    if (result.prepare === undefined && app.startupReports.length) {
      result.prepare = prepareRecord(app.startupReports[0], 0)
    }
    result.startup = caseReports.map((report, index) => summarize(report, index))
  }

  const cleanupOk =
    failures.length === 0 &&
    result.cleanup.applicationClosed &&
    result.cleanup.rpcClosed &&
    result.cleanup.generationDirectoriesRemoved &&
    result.cleanup.tunnelsClosed &&
    result.cleanup.ownedTestRootRemoved &&
    result.cleanup.transportsClosed
  if (!cleanupOk) {
    result.ok = false
    result.failedPhase ??= 'cleanup'
    result.failureReason ??= `Cleanup unconfirmed: ${failures.map((f) => f.name).join('; ') || 'a closure was not proven'}`
  }
  if (primary === undefined && !result.ok && !result.failureKind) result.failureKind = 'CLEANUP'
  result.elapsedMs = performance.now() - started
  return result
}

function summarize(
  report: R8Application['startupReports'][number],
  index: number
): Record<string, unknown> {
  return {
    attempt: index + 1,
    kind: index === 0 ? 'create' : 'resume',
    status: report.status,
    totalMs: report.totalMs,
    remoteCommands: report.steps.reduce((total, step) => total + step.remoteCommands, 0),
    steps: report.steps
  }
}
