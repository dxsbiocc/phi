#!/usr/bin/env bun

import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import type { Page } from 'playwright-core'

import { launchPackagedApp, type AppHandle } from './gui-e2e/app-launcher'
import { parseCli, usage } from './gui-e2e/cli'
import { readAppLogDirectory } from './gui-e2e/jsonl'
import {
  prepareIsolatedHome,
  sweepStaleIsolatedHomes,
  type PreparedIsolatedHome
} from './gui-e2e/profile'
import { matchServerProjects, readRemoteProjects } from './gui-e2e/projects'
import { ActualRequestBudget, readPersistedRequestEvents } from './gui-e2e/request-budget'
import { relativeScreenshot, reportScreenshotPath, writeReport } from './gui-e2e/report'
import { observeBudget, stopActiveRunBeforeScenario } from './gui-e2e/run-observer'
import { evaluateDryRun } from './gui-e2e/scenario-results'
import { runScenario } from './gui-e2e/scenarios'
import {
  BudgetSkip,
  ScenarioSkip,
  type CliOptions,
  type DryRunProbe,
  type HarnessContext,
  type ScenarioName,
  type ScenarioResult
} from './gui-e2e/types'
import {
  dismissUiOverlays,
  hoverProjectRow,
  openAndCloseSessionModeMenu,
  probeDryRunSelectors,
  selectModel
} from './gui-e2e/ui'

class ScenarioTimeoutError extends Error {
  constructor(
    readonly scenario: ScenarioName,
    readonly timeoutMs: number
  ) {
    super(`${scenario} timed out after ${timeoutMs} ms`)
    this.name = 'ScenarioTimeoutError'
  }
}

function safeRemovePreparedHome(prepared: PreparedIsolatedHome): void {
  const target = resolve(prepared.homeDir)
  const allowedRoots = [resolve(tmpdir()), resolve('/private/tmp')].map((root) => `${root}${sep}`)
  if (
    !allowedRoots.some((root) => target.startsWith(root)) ||
    !basename(target).startsWith('phi-gui-e2e-')
  ) {
    throw new Error(`Refusing to remove unexpected isolated HOME: ${target}`)
  }
  rmSync(target, { recursive: true, force: true })
}

function sweepHarnessTempRoots(): string {
  const primary = tmpdir()
  for (const root of new Set([primary, '/private/tmp'])) sweepStaleIsolatedHomes(root)
  return primary
}

function requestedProjects(
  options: CliOptions,
  home: string
): {
  projects: ReturnType<typeof readRemoteProjects>
  unmatched: string[]
} {
  const available = readRemoteProjects(home)
  const projects = matchServerProjects(available, options.servers)
  const unmatched = options.servers.filter(
    (name) => matchServerProjects(available, [name]).length === 0
  )
  return { projects, unmatched }
}

async function screenshotFailure(
  page: Page,
  options: CliOptions,
  name: string
): Promise<string | undefined> {
  const path = reportScreenshotPath(options.reportDir, name)
  try {
    await page.screenshot({ path, fullPage: true })
    return relativeScreenshot(options.reportDir, path)
  } catch {
    return undefined
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('GUI acceptance aborted')
}

async function withScenarioTimeout<T>(
  name: ScenarioName,
  timeoutMs: number,
  parent: AbortSignal,
  onAbort: (error: Error) => Promise<void>,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  let settled = false
  let rejectAbort: (error: Error) => void = () => undefined
  const aborted = new Promise<T>((_, reject) => {
    rejectAbort = reject
  })
  const cancel = async (error: Error): Promise<void> => {
    if (settled || controller.signal.aborted) return
    controller.abort(error)
    try {
      await onAbort(error)
    } finally {
      rejectAbort(error)
    }
  }
  const onParentAbort = (): void => void cancel(abortError(parent))
  parent.addEventListener('abort', onParentAbort, { once: true })
  const timeout = setTimeout(
    () => void cancel(new ScenarioTimeoutError(name, timeoutMs)),
    timeoutMs
  )
  try {
    return await Promise.race([run(controller.signal), aborted])
  } finally {
    settled = true
    clearTimeout(timeout)
    parent.removeEventListener('abort', onParentAbort)
  }
}

function resultFromError(
  name: ScenarioName,
  error: unknown,
  durationMs: number,
  modelRequests: number
): ScenarioResult {
  if (error instanceof ScenarioSkip) {
    return {
      name,
      status: 'skipped',
      durationMs,
      modelRequests,
      evidence: [],
      reason: error.reason
    }
  }
  const reason = error instanceof Error ? error.message : String(error)
  return { name, status: 'fail', durationMs, modelRequests, evidence: [], reason }
}

async function executeScenario(
  name: ScenarioName,
  base: HarnessContext,
  options: CliOptions,
  rootSignal: AbortSignal
): Promise<ScenarioResult> {
  observeBudget(base.home, base.budget)
  const before = base.budget.snapshot().usedRequests
  const started = Date.now()
  const startedAt = new Date().toISOString()
  let timeoutScreenshot: string | undefined
  const preflightEvidence: string[] = []
  try {
    if (!(await dismissUiOverlays(base.page))) {
      throw new Error('Unable to start scenario with a clean UI')
    }
    const outcome = await withScenarioTimeout(
      name,
      options.scenarioTimeoutMs,
      rootSignal,
      async (error) => {
        const stop = base.page.locator('[data-phi-composer-action="stop"]:visible').last()
        if ((await stop.count()) > 0) await stop.click().catch(() => undefined)
        await dismissUiOverlays(base.page).catch(() => false)
        if (error instanceof ScenarioTimeoutError) {
          timeoutScreenshot = await screenshotFailure(base.page, options, name)
        }
        await base.page
          .reload({ waitUntil: 'domcontentloaded', timeout: 10_000 })
          .catch(() => undefined)
      },
      async (signal) => {
        const context = { ...base, abortSignal: signal }
        const stopped = await stopActiveRunBeforeScenario(context)
        if (stopped) {
          preflightEvidence.push(
            `pre-scenario run stopped: ${stopped.runId} (${stopped.terminalEvent})`
          )
        }
        return runScenario(name, context)
      }
    )
    observeBudget(base.home, base.budget)
    const snapshot = base.budget.snapshot()
    if (snapshot.overLimit) {
      throw new Error(
        `Model request ceiling exceeded (${snapshot.usedRequests}/${snapshot.maxRequests})`
      )
    }
    const used = base.budget.snapshot().usedRequests - before
    const result: ScenarioResult = {
      name,
      status: outcome.passed ? 'pass' : 'fail',
      durationMs: Date.now() - started,
      modelRequests: used,
      evidence: [
        ...preflightEvidence,
        ...outcome.evidence,
        ...safeLogEvidence(base.home, startedAt)
      ],
      ...(outcome.reason ? { reason: outcome.reason } : {})
    }
    if (!outcome.passed) {
      await dismissUiOverlays(base.page).catch(() => false)
      result.screenshot = await screenshotFailure(base.page, options, name)
    }
    return result
  } catch (error) {
    observeBudget(base.home, base.budget)
    const result = resultFromError(
      name,
      error,
      Date.now() - started,
      base.budget.snapshot().usedRequests - before
    )
    result.evidence.push(...preflightEvidence, ...safeLogEvidence(base.home, startedAt))
    const clean = await dismissUiOverlays(base.page).catch(() => false)
    if (!(error instanceof BudgetSkip) && !(error instanceof ScenarioSkip)) {
      result.screenshot = timeoutScreenshot ?? (await screenshotFailure(base.page, options, name))
      if (!clean && !(error instanceof ScenarioTimeoutError)) {
        await base.page
          .reload({ waitUntil: 'domcontentloaded', timeout: 10_000 })
          .catch(() => undefined)
        await dismissUiOverlays(base.page).catch(() => false)
      }
    }
    return result
  }
}

function safeLogEvidence(home: string, since: string): string[] {
  const cutoff = Date.parse(since)
  return readAppLogDirectory(resolve(home, '.phi', 'logs'))
    .entries.filter((entry) => {
      const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
      return (
        Number.isFinite(timestamp) &&
        timestamp >= cutoff &&
        (entry.event.startsWith('run_') || entry.event.startsWith('remote_connection_'))
      )
    })
    .slice(-12)
    .map((entry) => {
      const metadata = entry.metadata ?? {}
      const fields = [
        entry.timestamp,
        entry.event,
        entry.sessionId ? `session=${entry.sessionId}` : undefined,
        entry.runId ? `run=${entry.runId}` : undefined,
        typeof metadata.layer === 'string' ? `layer=${metadata.layer}` : undefined,
        typeof metadata.target === 'string' ? `target=${metadata.target}` : undefined,
        typeof metadata.reason === 'string' ? `reason=${metadata.reason}` : undefined
      ]
      return fields.filter(Boolean).join(' ')
    })
}

async function probeModelPicker(page: Page, model: string, probes: DryRunProbe[]): Promise<void> {
  if (!model) {
    probes.push({
      name: 'model selection (no --model requested)',
      selector: '[data-phi-model-thinking="true"]',
      state: 'dynamic'
    })
    return
  }
  try {
    await selectModel(page, model)
    probes.push({ name: 'requested model selection', selector: model, state: 'found' })
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
    probes.push({
      name: `requested model selection (${detail.slice(0, 300)})`,
      selector: model,
      state: 'missing'
    })
    await dismissUiOverlays(page).catch(() => false)
  }
}

async function probeSessionModeMenu(page: Page, probes: DryRunProbe[]): Promise<void> {
  let found = false
  try {
    found = await openAndCloseSessionModeMenu(page)
  } catch {
    await dismissUiOverlays(page).catch(() => false)
  }
  probes.push({
    name: 'session mode menu opens and closes',
    selector: '[data-testid="gui-e2e-session-mode-plan"]',
    state: found ? 'found' : 'missing'
  })
}

async function probeProjectRows(
  page: Page,
  projects: ReturnType<typeof readRemoteProjects>,
  unmatched: string[],
  probes: DryRunProbe[]
): Promise<void> {
  for (const project of projects) {
    let found = false
    try {
      await hoverProjectRow(page, project)
      found = true
    } catch {
      found = false
    }
    probes.push({
      name: `project row by id for ${project.hostAlias}`,
      selector: `[data-phi-project-id="${project.id}"]`,
      state: found ? 'found' : 'missing'
    })
  }
  for (const server of unmatched) {
    probes.push({
      name: `configured server project ${server}`,
      selector: '[data-phi-project-id]',
      state: 'missing'
    })
  }
}

async function interactiveDryRunProbes(
  page: Page,
  options: CliOptions,
  selection: ReturnType<typeof requestedProjects>,
  probes: DryRunProbe[]
): Promise<void> {
  await dismissUiOverlays(page)
  await probeModelPicker(page, options.model, probes)
  await probeSessionModeMenu(page, probes)
  await probeProjectRows(page, selection.projects, selection.unmatched, probes)
  const clean = await dismissUiOverlays(page)
  probes.push({
    name: 'overlay cleanup leaves no popover',
    selector: '.MuiPopover-root:visible',
    state:
      clean && (await page.locator('.MuiPopover-root:visible').count()) === 0 ? 'found' : 'missing'
  })
}

async function runDryRun(
  page: Page,
  home: string,
  budget: ActualRequestBudget,
  options: CliOptions,
  selection: ReturnType<typeof requestedProjects>
): Promise<{ result: ScenarioResult; probes: DryRunProbe[] }> {
  const started = Date.now()
  const probes = await probeDryRunSelectors(page)
  await interactiveDryRunProbes(page, options, selection, probes)
  observeBudget(home, budget)
  const logs = readAppLogDirectory(resolve(home, '.phi', 'logs')).entries
  const remoteConnections = logs.filter(
    (entry) => entry.event === 'remote_connection_opened'
  ).length
  const requests = budget.snapshot().usedRequests
  const evaluation = evaluateDryRun({
    probes,
    modelRequests: requests,
    remoteConnections
  })
  return {
    probes,
    result: {
      name: 'dry-run',
      status: evaluation.passed ? 'pass' : 'fail',
      durationMs: Date.now() - started,
      modelRequests: requests,
      evidence: evaluation.evidence,
      ...(evaluation.reason ? { reason: evaluation.reason } : {})
    }
  }
}

function installAbortHandlers(controller: AbortController): () => void {
  const abort = (): void => controller.abort(new Error('Interrupted by user'))
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  return () => {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
}

async function observePendingSignal(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolveSignal) => setImmediate(resolveSignal))
  signal.throwIfAborted()
}

function failedRunResults(
  options: CliOptions,
  launchStarted: number,
  reason: string
): ScenarioResult[] {
  const names: Array<ScenarioName | 'dry-run'> = options.dryRun ? ['dry-run'] : options.scenarios
  return names.map((name) => ({
    name,
    status: 'fail',
    durationMs: Date.now() - launchStarted,
    modelRequests: 0,
    evidence: [],
    reason: `app launch failed: ${reason}`
  }))
}

async function runRealScenarios(
  options: CliOptions,
  context: HarnessContext,
  signal: AbortSignal
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []
  for (const name of options.scenarios) {
    observeBudget(context.home, context.budget)
    if (signal.aborted) {
      results.push({
        name,
        status: 'skipped',
        durationMs: 0,
        modelRequests: 0,
        evidence: [],
        reason: 'deadline'
      })
      continue
    }
    if (context.budget.snapshot().atLimit && name !== 'notebook-switch') {
      results.push({
        name,
        status: 'skipped',
        durationMs: 0,
        modelRequests: 0,
        evidence: [],
        reason: 'budget'
      })
      continue
    }
    results.push(await executeScenario(name, context, options, signal))
  }
  return results
}

function processOptions(): CliOptions | undefined {
  try {
    return parseCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    console.error(usage())
    process.exitCode = 2
    return undefined
  }
}

async function main(): Promise<void> {
  const options = processOptions()
  if (!options) return
  const root = new AbortController()
  const removeAbortHandlers = installAbortHandlers(root)
  const deadline = setTimeout(
    () => root.abort(new Error(`Overall deadline exceeded (${options.deadlineMs} ms)`)),
    options.deadlineMs
  )
  let prepared: PreparedIsolatedHome | undefined
  let selection: ReturnType<typeof requestedProjects> = {
    projects: [],
    unmatched: [...options.servers]
  }
  let budget: ActualRequestBudget | undefined
  let app: AppHandle | undefined
  let results: ScenarioResult[] = []
  let probes: DryRunProbe[] | undefined
  let launchMode: 'electron' | 'cdp' = 'electron'
  let fatalLaunchError = false
  const launchStarted = Date.now()
  try {
    const tempRoot = sweepHarnessTempRoots()
    await observePendingSignal(root.signal)
    prepared = prepareIsolatedHome({ tempRoot })
    await observePendingSignal(root.signal)
    selection = requestedProjects(options, prepared.homeDir)
    const baseline = readPersistedRequestEvents(prepared.agentDir)
    budget = new ActualRequestBudget(options.maxRequests, baseline.events)
    app = await launchPackagedApp(options.app, prepared.homeDir)
    root.signal.throwIfAborted()
    launchMode = app.mode
    app.page.setDefaultTimeout(30_000)
    if (options.dryRun) {
      const dry = await runDryRun(app.page, prepared.homeDir, budget, options, selection)
      results = [dry.result]
      probes = dry.probes
    } else {
      const context: HarnessContext = {
        page: app.page,
        home: prepared.homeDir,
        reportDir: options.reportDir,
        model: options.model,
        maxRequests: options.maxRequests,
        projects: selection.projects,
        budget,
        abortSignal: root.signal
      }
      results = await runRealScenarios(options, context, root.signal)
    }
  } catch (error) {
    fatalLaunchError = true
    const reason = error instanceof Error ? error.message : String(error)
    if (reason.includes('CDP')) launchMode = 'cdp'
    results = failedRunResults(options, launchStarted, reason)
  } finally {
    try {
      await app?.close().catch(() => undefined)
      if (prepared && !options.keepHome) safeRemovePreparedHome(prepared)
      writeReport({
        options,
        launchMode,
        results,
        probes,
        unmatchedServers: selection.unmatched,
        isolatedHomeRetained: Boolean(prepared && options.keepHome)
      })
    } finally {
      clearTimeout(deadline)
      removeAbortHandlers()
    }
  }

  for (const result of results) {
    console.log(`${result.status.toUpperCase()} ${result.name} (${result.modelRequests} requests)`)
  }
  if (options.keepHome && prepared) console.log(`Isolated HOME: ${prepared.homeDir}`)
  console.log(`Report: ${resolve(options.reportDir, 'report.md')}`)
  if (fatalLaunchError || results.some((result) => result.status === 'fail')) process.exitCode = 1
}

function runUnderNode(): number {
  const script = fileURLToPath(import.meta.url)
  const loader = resolve('scripts/test-loader.mjs')
  const child = spawnSync('node', ['--import', loader, script, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: { ...process.env, PHI_GUI_E2E_NODE_CHILD: '1' },
    stdio: 'inherit'
  })
  return child.status ?? 1
}

const runningUnderBun = Boolean(
  (process.versions as Record<string, string | undefined>).bun &&
  process.env.PHI_GUI_E2E_NODE_CHILD !== '1'
)

if (runningUnderBun) {
  process.exitCode = runUnderNode()
} else {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
