import { posix } from 'node:path'

import type {
  PlanSpec,
  PlanStep,
  PlanStepPreflightResult,
  PlanStepVerificationCheck,
  PlanStepVerificationResult
} from '../../../../shared/planRunTypes'
import {
  evaluateAsyncStepScientificCompatibility,
  evaluateStepScientificCompatibility
} from '../../scientific-context/compatibility'
import {
  computeRemoteArtifactSha256,
  readRemoteScientificContextSidecar
} from '../../scientific-context/remote-sidecar'
import {
  captureAsyncStepEvidenceFingerprint,
  captureStepEvidenceFingerprint,
  evaluateAsyncPlanStaleness,
  evaluatePlanStaleness,
  type PlanStalenessReport,
  type StepEvidenceFingerprint
} from '../../scientific-context/staleness'
import type { OutputContentAssertion } from '../../verification/output-assertions'
import { verifyRemoteFileContentAssertion } from '../../verification/remote-output-assertions'
import {
  createLocalMetricSourceReader,
  createRemoteMetricSourceReader,
  verifyScientificReportCrossCheck
} from '../../verification/scientific-verdict-crosscheck'
import { extractStructuredScientificPayload } from '../../agents/research-handoff'
import type { RemoteSshSession } from '../../wrappers/remote-ssh-session'
import { verifyPlanStepChecks } from './step-verification'

export interface RemotePlanWorkspaceTarget {
  rootDir: string
  host: string
  getSshSession(): Promise<RemoteSshSession>
}

export type ResolvedPlanWorkspace =
  | { kind: 'local'; rootDir: string }
  | { kind: 'remote'; target: RemotePlanWorkspaceTarget }
  | { kind: 'unavailable'; reason?: string }

function assertionForCheck(check: PlanStepVerificationCheck): OutputContentAssertion {
  switch (check.kind) {
    case 'file_exists':
      return {}
    case 'non_empty_file':
      return { nonEmpty: true }
    case 'json_valid':
      return { nonEmpty: true, format: 'json' }
    case 'table_schema':
      return {
        nonEmpty: true,
        format: check.format ?? 'tsv',
        ...(check.minDataRows !== undefined ? { minDataRows: check.minDataRows } : {}),
        ...(check.minColumns !== undefined ? { minColumns: check.minColumns } : {}),
        ...(check.requiredColumns?.length ? { requiredColumns: check.requiredColumns } : {})
      }
  }
}

export interface StepVerificationContext {
  spec?: PlanSpec
  reportText?: string
}

export function stepReportRequiresWorkspaceCrossCheck(reportText: string | undefined): boolean {
  const payload = extractStructuredScientificPayload(reportText)
  return Boolean(payload?.keyMetrics?.length)
}

function checkHypothesisIdIntegrity(
  spec: PlanSpec | undefined,
  reportText: string | undefined
): string[] {
  const payload = extractStructuredScientificPayload(reportText)
  if (!payload?.hypothesisVerdicts?.length || !spec?.hypotheses) return []
  const knownIds = new Set(spec.hypotheses.map((h) => h.id))
  return payload.hypothesisVerdicts
    .filter((item) => !knownIds.has(item.hypothesisId))
    .map((item) => `hypothesisVerdict references undeclared hypothesisId "${item.hypothesisId}"`)
}

async function runRemoteStepVerification(
  step: PlanStep,
  target: RemotePlanWorkspaceTarget,
  context?: StepVerificationContext
): Promise<PlanStepVerificationResult> {
  let session: RemoteSshSession
  try {
    session = await target.getSshSession()
  } catch (error) {
    return {
      ok: false,
      failures: [
        `Remote SSH host "${target.host}" is unreachable; cannot verify step "${step.id}": ${
          error instanceof Error ? error.message : String(error)
        }`
      ]
    }
  }

  const failures: string[] = []
  for (const check of step.checks ?? []) {
    const remotePath = posix.resolve(target.rootDir, check.path)
    const verdict = await verifyRemoteFileContentAssertion(
      session,
      remotePath,
      assertionForCheck(check),
      { remoteRootDir: target.rootDir }
    )
    if (!verdict.ok) {
      failures.push(`${check.kind}(${check.path}): ${verdict.reason ?? 'verification failed'}`)
    }
  }
  const crossCheck = await verifyScientificReportCrossCheck({
    spec: context?.spec,
    step,
    reportText: context?.reportText,
    readSource: createRemoteMetricSourceReader(session, target.rootDir)
  })
  failures.push(...crossCheck.failures)
  return { ok: failures.length === 0, failures }
}

/**
 * Evaluates post-step `checks` and structured `keyMetrics` / `hypothesisVerdicts`
 * across local and SSH remote workspaces.
 * Never silently returns `ok: true` when verification is required and the workspace
 * is unavailable or disconnected.
 */
export async function verifyWorkspacePlanStepChecks(
  step: PlanStep,
  workspace: ResolvedPlanWorkspace,
  context?: StepVerificationContext
): Promise<PlanStepVerificationResult> {
  const needsMetricCheck = stepReportRequiresWorkspaceCrossCheck(context?.reportText)
  const hasChecks = Boolean(step.checks?.length)
  if (!hasChecks && !needsMetricCheck) {
    const idFailures = checkHypothesisIdIntegrity(context?.spec, context?.reportText)
    return { ok: idFailures.length === 0, failures: idFailures }
  }
  if (workspace.kind === 'local') {
    const base = verifyPlanStepChecks(step, workspace.rootDir)
    const cross = await verifyScientificReportCrossCheck({
      spec: context?.spec,
      step,
      reportText: context?.reportText,
      readSource: createLocalMetricSourceReader(workspace.rootDir)
    })
    const failures = [...base.failures, ...cross.failures]
    return { ok: failures.length === 0, failures }
  }
  if (workspace.kind === 'unavailable') {
    return {
      ok: false,
      failures: [
        workspace.reason ??
          `Workspace root unavailable; cannot verify checks or keyMetrics for step "${step.id}".`
      ]
    }
  }
  return runRemoteStepVerification(step, workspace.target, context)
}

/**
 * Evaluates pre-launch `inputContracts` across local and SSH remote workspaces.
 * Fails closed (`needs_input`) when `inputContracts` are declared and the workspace
 * or SSH host is unavailable — never silently assuming `compatible`.
 */
export async function evaluateWorkspaceStepCompatibility(
  step: PlanStep,
  workspace: ResolvedPlanWorkspace
): Promise<PlanStepPreflightResult> {
  if (!step.inputContracts?.length) return { status: 'compatible' }
  if (workspace.kind === 'local') {
    return evaluateStepScientificCompatibility(step, workspace.rootDir)
  }
  if (workspace.kind === 'unavailable') {
    return {
      status: 'needs_input',
      missingInputs: step.inputContracts.map((c) => c.path),
      summary:
        workspace.reason ??
        `Workspace root unavailable; cannot verify scientific input contracts before launching "${step.id}".`
    }
  }

  let session: RemoteSshSession
  try {
    session = await workspace.target.getSshSession()
  } catch (error) {
    return {
      status: 'needs_input',
      missingInputs: step.inputContracts.map((c) => c.path),
      summary: `Remote SSH host "${workspace.target.host}" is unreachable; cannot verify scientific input contracts before launching "${step.id}": ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }

  try {
    return await evaluateAsyncStepScientificCompatibility(step, async (relPath) => {
      const remotePath = posix.resolve(workspace.target.rootDir, relPath)
      const { sidecar } = await readRemoteScientificContextSidecar(
        session,
        remotePath,
        workspace.target.host,
        workspace.target.rootDir
      )
      return sidecar
    })
  } catch (error) {
    return {
      status: 'needs_input',
      missingInputs: step.inputContracts.map((c) => c.path),
      summary: `Remote SSH verification failed on "${workspace.target.host}" before launching "${step.id}": ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
}

async function inspectRemoteArtifactFingerprint(
  session: RemoteSshSession,
  target: RemotePlanWorkspaceTarget,
  relPath: string
): Promise<{ contentSha256?: string; contextVersion?: number }> {
  const remotePath = posix.resolve(target.rootDir, relPath)
  const contentSha256 = await computeRemoteArtifactSha256(session, remotePath, target.rootDir)
  const { found, sidecar } = await readRemoteScientificContextSidecar(
    session,
    remotePath,
    target.host,
    target.rootDir
  )
  return {
    ...(contentSha256 ? { contentSha256 } : {}),
    ...(found ? { contextVersion: sidecar.artifact.contextVersion } : {})
  }
}

export async function captureWorkspaceStepEvidenceFingerprints(
  steps: readonly PlanStep[],
  workspace: ResolvedPlanWorkspace
): Promise<Record<string, StepEvidenceFingerprint> | null> {
  if (workspace.kind === 'unavailable') return null
  if (workspace.kind === 'local') {
    const out: Record<string, StepEvidenceFingerprint> = {}
    for (const step of steps) {
      out[step.id] = captureStepEvidenceFingerprint(step, workspace.rootDir)
    }
    return out
  }
  const session = await workspace.target.getSshSession()
  const out: Record<string, StepEvidenceFingerprint> = {}
  for (const step of steps) {
    out[step.id] = await captureAsyncStepEvidenceFingerprint(step, (relPath) =>
      inspectRemoteArtifactFingerprint(session, workspace.target, relPath)
    )
  }
  return out
}

export async function evaluateWorkspacePlanStaleness(
  spec: PlanSpec,
  recordedFingerprints: Readonly<Record<string, StepEvidenceFingerprint>>,
  workspace: ResolvedPlanWorkspace
): Promise<PlanStalenessReport | null> {
  if (workspace.kind === 'unavailable') return null
  if (workspace.kind === 'local') {
    return evaluatePlanStaleness(spec, recordedFingerprints, workspace.rootDir)
  }
  const session = await workspace.target.getSshSession()
  return evaluateAsyncPlanStaleness(spec, recordedFingerprints, (relPath) =>
    inspectRemoteArtifactFingerprint(session, workspace.target, relPath)
  )
}
