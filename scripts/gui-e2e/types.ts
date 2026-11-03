import type { Page } from 'playwright-core'

import type { ActualRequestBudget } from './request-budget'

export const SCENARIO_NAMES = [
  'plan-mode',
  'switch-servers',
  'remote-fork',
  'reconnect-return',
  'outside-read-approval',
  'notebook-switch'
] as const

export type ScenarioName = (typeof SCENARIO_NAMES)[number]
export type ScenarioStatus = 'pass' | 'fail' | 'skipped'

export interface CliOptions {
  app: string
  servers: string[]
  model: string
  maxRequests: number
  scenarios: ScenarioName[]
  dryRun: boolean
  keepHome: boolean
  reportDir: string
  scenarioTimeoutMs: number
  deadlineMs: number
}

export interface RemoteProject {
  id: string
  name: string
  workingDirectory: string
  hostAlias: string
  hostProfileId: string
}

export interface ScenarioResult {
  name: ScenarioName | 'dry-run'
  status: ScenarioStatus
  durationMs: number
  modelRequests: number
  evidence: string[]
  screenshot?: string
  reason?: string
}

export interface RunObservation {
  runId: string
  sessionId?: string
  terminalEvent: 'run_completed' | 'run_failed' | 'run_interrupted'
  error?: string
}

export interface DryRunProbe {
  name: string
  selector: string
  state: 'found' | 'missing' | 'dynamic'
}

export interface HarnessContext {
  page: Page
  home: string
  reportDir: string
  model: string
  maxRequests: number
  projects: RemoteProject[]
  budget: ActualRequestBudget
  abortSignal: AbortSignal
}

export class ScenarioSkip extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'ScenarioSkip'
  }
}

export class BudgetSkip extends ScenarioSkip {
  constructor() {
    super('budget')
    this.name = 'BudgetSkip'
  }
}
