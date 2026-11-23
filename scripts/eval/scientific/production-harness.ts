import { mkdirSync, writeFileSync } from 'node:fs'

import {
  extractVisibleTaskCard,
  trialEvidencePaths,
  validateVisibleTaskCard,
  type VisibleEvalTaskCard
} from './contract'
import {
  createTrialSandbox,
  verifyIsolationBoundary,
  type IsolationCanaryReport,
  type TrialSandbox
} from './isolation'
import {
  scoreTrial,
  type SystemClaim,
  type TabularScoringRule,
  type TrialExecutionOutcome,
  type TrialScoreReport
} from './scorer'

/**
 * Production Phi evaluation harness & host-service assembly gate (R02).
 *
 * Enforces:
 * - Explicit inventory of all 7 required production host services (`model`, `approval`,
 *   `environment`, `decision`, `notebook`, `wrapper`, `completionFlow`).
 * - In `production` mode, any missing or mock/stub service fails fast rather than silently
 *   falling back to simulated tools or scripted answers.
 * - Integrates R01 (task contract), R03 (per-trial sandbox + canary verification), and
 *   R09 (independent read-only scientific artifact scorer) into one durable evidence bundle.
 */

export const REQUIRED_PRODUCTION_SERVICES = [
  'model',
  'approval',
  'environment',
  'decision',
  'notebook',
  'wrapper',
  'completionFlow'
] as const

export type RequiredProductionService = (typeof REQUIRED_PRODUCTION_SERVICES)[number]

export type EvalRunMode = 'production' | 'engineering_calibration'

export interface ServiceBindingDescriptor {
  service: RequiredProductionService
  implementation: 'production' | 'controlled_mock' | 'missing'
  /** Concrete module or handler identifier (e.g. `app-kernel-desktop-services.ts`). */
  provider: string
  notes?: string
}

export interface ProductionAssemblyManifest {
  mode: EvalRunMode
  hostRuntime: 'electron_headless' | 'kernel_cli' | 'calibration_harness'
  services: Record<RequiredProductionService, ServiceBindingDescriptor>
}

export interface AssemblyValidationResult {
  ok: boolean
  errors: string[]
}

export function validateProductionAssembly(
  manifest: ProductionAssemblyManifest
): AssemblyValidationResult {
  const errors: string[] = []
  for (const name of REQUIRED_PRODUCTION_SERVICES) {
    const binding = manifest.services[name]
    if (!binding || binding.implementation === 'missing') {
      errors.push(`required service "${name}" is missing`)
      continue
    }
    if (!binding.provider.trim()) {
      errors.push(`service "${name}" must declare its concrete provider/module`)
    }
    if (manifest.mode === 'production' && binding.implementation !== 'production') {
      errors.push(
        `service "${name}" uses "${binding.implementation}" which is forbidden in production evaluation mode`
      )
    }
  }
  return { ok: errors.length === 0, errors }
}

export interface TrialExecutionReceipt {
  outcome: TrialExecutionOutcome
  systemClaim: SystemClaim
  sessionId: string
  events: Array<{ type: string; timestamp: string; detail?: Record<string, unknown> }>
  error?: string
}

export interface RunEvaluatedTrialInput {
  trialId: string
  arm: string
  task: VisibleEvalTaskCard
  assembly: ProductionAssemblyManifest
  artifactsBaseDir: string
  hiddenReferenceDir: string
  scoringRules: readonly TabularScoringRule[]
  expectsRejection?: boolean
  sharedReadOnlyCaches?: readonly string[]
  baseTempDir?: string
  /** Executes the task inside the isolated sandbox using the assembled Phi host services. */
  execute: (context: {
    sandbox: TrialSandbox
    visibleTask: VisibleEvalTaskCard
    assembly: ProductionAssemblyManifest
  }) => Promise<TrialExecutionReceipt>
  /** Agent-side file read probe used for the R03 canary check before execution. */
  attemptCanaryRead: (sandbox: TrialSandbox, targetPath: string) => Promise<boolean>
  /** Keep sandbox directory on disk after completion (default false). */
  keepSandbox?: boolean
}

export interface EvaluatedTrialResult {
  trialId: string
  studyId: string
  taskId: string
  mode: EvalRunMode
  evidenceDir: string
  isolation: IsolationCanaryReport
  receipt: TrialExecutionReceipt
  score: TrialScoreReport
}

export async function runEvaluatedTrial(
  input: RunEvaluatedTrialInput
): Promise<EvaluatedTrialResult> {
  const contractCheck = validateVisibleTaskCard(input.task)
  if (!contractCheck.ok) {
    throw new Error(`Invalid eval task card "${input.task.taskId}": ${contractCheck.errors.join('; ')}`)
  }
  const assemblyCheck = validateProductionAssembly(input.assembly)
  if (!assemblyCheck.ok) {
    throw new Error(`Production assembly check failed: ${assemblyCheck.errors.join('; ')}`)
  }

  const visibleTask = extractVisibleTaskCard(input.task)
  const sandbox = createTrialSandbox({
    trialId: input.trialId,
    baseTempDir: input.baseTempDir,
    sharedReadOnlyCaches: input.sharedReadOnlyCaches,
    hiddenReferenceRoot: input.hiddenReferenceDir
  })

  const evidence = trialEvidencePaths(input.artifactsBaseDir, visibleTask.studyId, input.trialId)
  mkdirSync(evidence.rootDir, { recursive: true })

  try {
    const isolation = await verifyIsolationBoundary({
      sandbox,
      hiddenReferenceDir: input.hiddenReferenceDir,
      attemptRead: (targetPath) => input.attemptCanaryRead(sandbox, targetPath)
    })
    if (isolation.status === 'failed') {
      throw new Error(
        `Isolation canary breach before trial "${input.trialId}": ${isolation.checks
          .filter((c) => c.status === 'leaked')
          .map((c) => c.detail)
          .join('; ')}`
      )
    }

    writeFileSync(
      evidence.configJson,
      `${JSON.stringify(
        {
          trialId: input.trialId,
          arm: input.arm,
          mode: input.assembly.mode,
          hostRuntime: input.assembly.hostRuntime,
          task: visibleTask,
          assembly: input.assembly,
          sharedReadOnlyCaches: sandbox.sharedReadOnlyCaches
        },
        null,
        2
      )}\n`,
      'utf-8'
    )

    const receipt = await input.execute({
      sandbox,
      visibleTask,
      assembly: input.assembly
    })

    writeFileSync(
      evidence.eventsJsonl,
      `${receipt.events.map((event) => JSON.stringify(event)).join('\n')}${receipt.events.length ? '\n' : ''}`,
      'utf-8'
    )

    const score = scoreTrial({
      taskId: visibleTask.taskId,
      taskVersion: visibleTask.taskVersion,
      trialId: input.trialId,
      workspaceDir: sandbox.cwd,
      executionOutcome: receipt.outcome,
      systemClaim: receipt.systemClaim,
      expectsRejection: input.expectsRejection,
      rules: input.scoringRules
    })

    writeFileSync(
      evidence.verificationJson,
      `${JSON.stringify(
        {
          isolation,
          assemblyValidated: true,
          mode: input.assembly.mode
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(evidence.scoreJson, `${JSON.stringify(score, null, 2)}\n`, 'utf-8')

    return {
      trialId: input.trialId,
      studyId: visibleTask.studyId,
      taskId: visibleTask.taskId,
      mode: input.assembly.mode,
      evidenceDir: evidence.rootDir,
      isolation,
      receipt,
      score
    }
  } finally {
    if (!input.keepSandbox) sandbox.cleanup()
  }
}
