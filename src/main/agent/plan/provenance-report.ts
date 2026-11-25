import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

import { isRecord } from '../../../shared/guards'
import type {
  HypothesisVerdictStatus,
  LiteratureVerificationStatus,
  PlanRunState,
  PlanStep,
  ScientificKeyMetricRecord,
  StatisticalUnit
} from '../../../shared/planRunTypes'
import { extractStructuredScientificPayload } from '../agents/research-handoff'
import { computeArtifactSha256, readScientificContextSidecar } from '../scientific-context/sidecar'
import {
  buildWrapperReproducibilityBundle,
  type WrapperManifestSource
} from '../wrappers/reproducibility'

const WRAPPER_RUN_ID_PATTERN = /\bwrun_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi

export interface ProvenanceHypothesisSummary {
  id: string
  statement: string
  selected: boolean
  statisticalUnit: StatisticalUnit | 'unspecified'
  falsificationCriteria?: string
  verdict: HypothesisVerdictStatus | 'untested'
  supportingStepIds: string[]
}

export interface ProvenanceArtifactRecord {
  path: string
  contentSha256: string
  anchor: string
  valueSemantics: string
  referenceAssembly: string
  sampleCount?: number
  donorCount?: number
}

export interface ProvenanceWrapperRunRecord {
  runId: string
  wrapperId: string
  wrapperVersion: string
  manifestSource: WrapperManifestSource | 'unknown'
  manifestSha256: string
  nextflowVersion: string
  containerEngine: string
  pinnedImages: Array<{ ref: string; digest: string; status: 'verified' | 'unknown' }>
}

export interface ProvenanceNotebookRecord {
  path: string
  contentSha256: string
  kernelName: string
  source: 'managed' | 'host' | 'unknown'
  envId: string
  lockSha256: string
}

export interface ProvenanceEpistemicAudit {
  isExploratoryPostHoc: boolean
  postHocReplanCount: number
  untestedSelectedHypothesisIds: string[]
  literatureVerificationStatus: LiteratureVerificationStatus | 'not_requested' | 'unverified'
  warnings: string[]
}

export interface PlanProvenanceReportBundle {
  compiledAt: string
  phiVersion: string
  runId: string
  sessionId: string
  goal: string
  researchQuestion?: string
  status: PlanRunState['status']
  hypotheses: ProvenanceHypothesisSummary[]
  artifacts: ProvenanceArtifactRecord[]
  wrapperRuns: ProvenanceWrapperRunRecord[]
  notebooks: ProvenanceNotebookRecord[]
  keyMetrics: Array<ScientificKeyMetricRecord & { stepId: string; anchor: string }>
  confoundersChecked: string[]
  epistemicAudit: ProvenanceEpistemicAudit
  markdown: string
}

export interface CompilePlanProvenanceReportInput {
  state: PlanRunState
  projectRoot?: string
  agentDir?: string
  phiVersion?: string
  wrapperRunIds?: readonly string[]
}

function withinLocalRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

function safeResolveInProject(realRoot: string | undefined, relPath: string): string | undefined {
  if (!realRoot || isAbsolute(relPath) || relPath.split(/[\\/]+/).includes('..')) return undefined
  const target = resolve(realRoot, relPath)
  if (!withinLocalRoot(target, realRoot)) return undefined
  try {
    if (!existsSync(target) || !lstatSync(target).isFile()) return undefined
    const realTarget = realpathSync(target)
    return withinLocalRoot(realTarget, realRoot) ? realTarget : undefined
  } catch {
    return undefined
  }
}

function isWorkspaceArtifactEvidence(ev: string): boolean {
  const isWrapperId = WRAPPER_RUN_ID_PATTERN.test(ev)
  WRAPPER_RUN_ID_PATTERN.lastIndex = 0
  return !isWrapperId && !ev.includes('://') && !ev.startsWith('PMID:')
}

function addStepArtifactPaths(
  step: PlanStep,
  reportText: string | undefined,
  paths: Set<string>
): void {
  for (const w of step.writes ?? []) paths.add(w)
  for (const c of step.checks ?? []) paths.add(c.path)
  for (const ic of step.inputContracts ?? []) paths.add(ic.path)
  const payload = extractStructuredScientificPayload(reportText)
  if (!payload) return
  for (const ev of payload.evidence ?? []) {
    if (isWorkspaceArtifactEvidence(ev)) paths.add(ev)
  }
  for (const km of payload.keyMetrics ?? []) paths.add(km.sourcePath)
}

function collectReferencedArtifactPaths(state: PlanRunState): string[] {
  const paths = new Set<string>()
  for (const step of state.spec.steps) {
    addStepArtifactPaths(step, state.steps[step.id]?.report?.text, paths)
  }
  return [...paths].filter((p) => !isAbsolute(p) && !p.split(/[\\/]+/).includes('..')).sort()
}

function collectWrapperRunIds(state: PlanRunState, extra: readonly string[] = []): string[] {
  const ids = new Set<string>(extra)
  for (const step of state.spec.steps) {
    const text = state.steps[step.id]?.report?.text ?? ''
    for (const match of text.matchAll(WRAPPER_RUN_ID_PATTERN)) {
      ids.add(match[0])
    }
  }
  return [...ids].sort()
}

function buildArtifactRecord(
  relPath: string,
  realRoot: string | undefined
): ProvenanceArtifactRecord {
  const realTarget = safeResolveInProject(realRoot, relPath)
  const sha = realTarget ? (computeArtifactSha256(realTarget) ?? 'unknown') : 'unknown'
  const shortSha = sha === 'unknown' ? 'unknown' : sha.slice(0, 12)
  const anchor = `[artifact: ${relPath}#${shortSha}]`
  if (!realTarget) {
    return {
      path: relPath,
      contentSha256: 'unknown',
      anchor,
      valueSemantics: 'unknown',
      referenceAssembly: 'unknown'
    }
  }
  const { sidecar } = readScientificContextSidecar(realTarget)
  const valueSemantics =
    sidecar.matrix.status !== 'unknown' ? sidecar.matrix.value.valueSemantics : 'unknown'
  const referenceAssembly =
    sidecar.reference.status !== 'unknown' ? sidecar.reference.value.assembly : 'unknown'
  const sampleVal = sidecar.samples.status !== 'unknown' ? sidecar.samples.value : undefined
  const sampleCount = sampleVal ? sampleVal.sampleIds.length : undefined
  const donorCount = sampleVal?.donorBySample
    ? new Set(Object.values(sampleVal.donorBySample)).size
    : undefined
  return {
    path: relPath,
    contentSha256: sha,
    anchor,
    valueSemantics,
    referenceAssembly,
    ...(sampleCount !== undefined ? { sampleCount } : {}),
    ...(donorCount !== undefined ? { donorCount } : {})
  }
}

function inspectNotebookProvenance(
  relPath: string,
  realRoot: string | undefined,
  sha256: string
): ProvenanceNotebookRecord | undefined {
  if (!relPath.toLowerCase().endsWith('.ipynb')) return undefined
  const realTarget = safeResolveInProject(realRoot, relPath)
  if (!realTarget) {
    return {
      path: relPath,
      contentSha256: sha256,
      kernelName: 'unknown',
      source: 'unknown',
      envId: 'unknown',
      lockSha256: 'unknown'
    }
  }
  try {
    const raw = JSON.parse(readFileSync(realTarget, 'utf-8')) as unknown
    const meta = isRecord(raw) && isRecord(raw.metadata) ? raw.metadata : {}
    const phi = isRecord(meta.phi) ? meta.phi : {}
    const execEnv = isRecord(phi.executionEnvironment) ? phi.executionEnvironment : {}
    const kspec = isRecord(meta.kernelspec) ? meta.kernelspec : {}
    const kernelName =
      typeof execEnv.kernelName === 'string'
        ? execEnv.kernelName
        : typeof kspec.name === 'string'
          ? kspec.name
          : 'unknown'
    const source =
      execEnv.source === 'managed' || execEnv.source === 'host' ? execEnv.source : 'unknown'
    return {
      path: relPath,
      contentSha256: sha256,
      kernelName,
      source,
      envId: typeof execEnv.envId === 'string' ? execEnv.envId : 'unknown',
      lockSha256: typeof execEnv.lockSha256 === 'string' ? execEnv.lockSha256 : 'unknown'
    }
  } catch {
    return {
      path: relPath,
      contentSha256: sha256,
      kernelName: 'unknown',
      source: 'unknown',
      envId: 'unknown',
      lockSha256: 'unknown'
    }
  }
}

function inspectWrapperRunProvenance(
  runId: string,
  agentDir: string | undefined
): ProvenanceWrapperRunRecord | undefined {
  try {
    const bundle = buildWrapperReproducibilityBundle(runId, agentDir)
    const guide = bundle.rerunGuide
    return {
      runId,
      wrapperId: guide.wrapperId,
      wrapperVersion: guide.wrapperVersion,
      manifestSource: bundle.manifestSource ?? 'unknown',
      manifestSha256: bundle.manifestSha256 ?? 'unknown',
      nextflowVersion: guide.nextflowVersion ?? 'unknown',
      containerEngine: guide.containerEngine ?? 'unknown',
      pinnedImages: guide.pinnedImages.map((img) => ({
        ref: img.ref,
        digest: img.digest ?? 'unknown',
        status: img.status
      }))
    }
  } catch {
    return undefined
  }
}

function aggregateHypotheses(state: PlanRunState): ProvenanceHypothesisSummary[] {
  const verdictByHyp = new Map<string, HypothesisVerdictStatus>()
  const stepsByHyp = new Map<string, Set<string>>()

  for (const step of state.spec.steps) {
    for (const hid of step.hypothesisIds ?? []) {
      const set = stepsByHyp.get(hid) ?? new Set<string>()
      set.add(step.id)
      stepsByHyp.set(hid, set)
    }
    if (state.steps[step.id]?.status !== 'done') continue
    const payload = extractStructuredScientificPayload(state.steps[step.id]?.report?.text)
    for (const item of payload?.hypothesisVerdicts ?? []) {
      verdictByHyp.set(item.hypothesisId, item.verdict)
      const set = stepsByHyp.get(item.hypothesisId) ?? new Set<string>()
      set.add(step.id)
      stepsByHyp.set(item.hypothesisId, set)
    }
  }

  return (state.spec.hypotheses ?? []).map((hyp) => ({
    id: hyp.id,
    statement: hyp.statement,
    selected: hyp.selected,
    statisticalUnit: hyp.statisticalUnit ?? 'unspecified',
    ...(hyp.falsificationCriteria ? { falsificationCriteria: hyp.falsificationCriteria } : {}),
    verdict: verdictByHyp.get(hyp.id) ?? 'untested',
    supportingStepIds: [...(stepsByHyp.get(hyp.id) ?? [])].sort()
  }))
}

function collectMetricsAndConfounders(
  state: PlanRunState,
  anchorByPath: ReadonlyMap<string, string>
): {
  keyMetrics: Array<ScientificKeyMetricRecord & { stepId: string; anchor: string }>
  confoundersChecked: string[]
} {
  const keyMetrics: Array<ScientificKeyMetricRecord & { stepId: string; anchor: string }> = []
  const confounders = new Set<string>()
  for (const step of state.spec.steps) {
    if (state.steps[step.id]?.status !== 'done') continue
    const payload = extractStructuredScientificPayload(state.steps[step.id]?.report?.text)
    for (const c of payload?.confoundersChecked ?? []) confounders.add(c)
    for (const km of payload?.keyMetrics ?? []) {
      keyMetrics.push({
        ...km,
        stepId: step.id,
        anchor: anchorByPath.get(km.sourcePath) ?? `[artifact: ${km.sourcePath}#unknown]`
      })
    }
  }
  return { keyMetrics, confoundersChecked: [...confounders].sort() }
}

function buildEpistemicAudit(
  state: PlanRunState,
  hypotheses: readonly ProvenanceHypothesisSummary[],
  notebooks: readonly ProvenanceNotebookRecord[],
  wrapperRuns: readonly ProvenanceWrapperRunRecord[]
): ProvenanceEpistemicAudit {
  const warnings: string[] = []
  const isExploratoryPostHoc = state.replans > 0
  if (isExploratoryPostHoc) {
    warnings.push(
      `Plan underwent ${state.replans} mid-run replan(s); treat revised thresholds or branches as post-hoc exploratory analysis rather than pre-registered confirmation.`
    )
  }
  const untestedSelected = hypotheses
    .filter((h) => h.selected && h.verdict === 'untested')
    .map((h) => h.id)
  if (untestedSelected.length > 0) {
    warnings.push(
      `Selected hypothesis(es) remain untested (${untestedSelected.join(', ')}); alternative explanations cannot be excluded.`
    )
  }
  const lit = state.spec.literatureReview
  const litStatus: ProvenanceEpistemicAudit['literatureVerificationStatus'] =
    !lit || !lit.needed ? 'not_requested' : (lit.verificationStatus ?? 'unverified')
  if (litStatus === 'unverified_offline' || litStatus === 'unverified') {
    warnings.push(`Literature citations carry status "${litStatus}" (not live-verified online).`)
  }
  for (const nb of notebooks) {
    if (nb.source !== 'managed' || nb.lockSha256 === 'unknown') {
      warnings.push(
        `Notebook "${nb.path}" lacks a pinned managed lock digest (source=${nb.source}, lockSha256=${nb.lockSha256}).`
      )
    }
  }
  for (const wr of wrapperRuns) {
    if (wr.manifestSource !== 'snapshot') {
      warnings.push(
        `Wrapper run "${wr.runId}" (${wr.wrapperId}) lacks an immutable manifest.snapshot.json (source=${wr.manifestSource}).`
      )
    }
  }
  return {
    isExploratoryPostHoc,
    postHocReplanCount: state.replans,
    untestedSelectedHypothesisIds: untestedSelected,
    literatureVerificationStatus: litStatus,
    warnings
  }
}

function formatStepLine(step: PlanStep, state: PlanRunState): string {
  const st = state.steps[step.id]
  const status = st?.status ?? 'pending'
  const summary = st?.report?.text
    ? extractStructuredScientificPayload(st.report.text)?.answer
    : undefined
  const detail = summary ?? st?.error ?? ''
  return `- **${step.id}** (${step.title}): \`${status}\`${detail ? ` — ${detail}` : ''}`
}

function renderMethodsSection(
  phiVersion: string,
  wrapperRuns: readonly ProvenanceWrapperRunRecord[],
  notebooks: readonly ProvenanceNotebookRecord[],
  artifacts: readonly ProvenanceArtifactRecord[]
): string[] {
  const lines = [
    '## 5. Online Methods & Software Provenance',
    `- **Phi Workbench Version**: \`${phiVersion}\``
  ]
  if (wrapperRuns.length === 0) {
    lines.push('- **Wrapper Runs**: none recorded')
  } else {
    for (const wr of wrapperRuns) {
      const imgs =
        wr.pinnedImages.length > 0
          ? wr.pinnedImages.map((i) => `${i.ref}@${i.digest} (${i.status})`).join(', ')
          : 'unknown'
      lines.push(
        `- **Wrapper \`${wr.wrapperId}\`** (run \`${wr.runId}\`): version=\`${wr.wrapperVersion}\`, manifestSource=\`${wr.manifestSource}\`, manifestSha256=\`${wr.manifestSha256}\`, nextflow=\`${wr.nextflowVersion}\`, containerEngine=\`${wr.containerEngine}\`, images=[${imgs}]`
      )
    }
  }
  if (notebooks.length > 0) {
    for (const nb of notebooks) {
      lines.push(
        `- **Notebook \`${nb.path}\`**: sha256=\`${nb.contentSha256}\`, kernel=\`${nb.kernelName}\`, source=\`${nb.source}\`, envId=\`${nb.envId}\`, lockSha256=\`${nb.lockSha256}\``
      )
    }
  }
  if (artifacts.length > 0) {
    lines.push('- **Artifact Context Ledger**:')
    for (const art of artifacts) {
      const counts =
        art.sampleCount !== undefined
          ? `, samples=${art.sampleCount}${art.donorCount !== undefined ? `, donors=${art.donorCount}` : ''}`
          : ''
      lines.push(
        `  - ${art.anchor}: sha256=\`${art.contentSha256}\`, semantics=\`${art.valueSemantics}\`, reference=\`${art.referenceAssembly}\`${counts}`
      )
    }
  }
  return lines
}

function renderProvenanceMarkdown(bundle: Omit<PlanProvenanceReportBundle, 'markdown'>): string {
  const lines: string[] = [
    `# Scientific Execution & Provenance Report`,
    `- **Run ID**: \`${bundle.runId}\` | **Status**: \`${bundle.status}\` | **Compiled At**: \`${bundle.compiledAt}\``,
    `- **Goal**: ${bundle.goal}`,
    ...(bundle.researchQuestion ? [`- **Research Question**: ${bundle.researchQuestion}`] : []),
    '',
    '## 1. Research Question & Pre-registered Hypotheses'
  ]
  const lit = bundle.epistemicAudit.literatureVerificationStatus
  lines.push(`- **Literature Verification Status**: \`${lit}\``)
  if (bundle.hypotheses.length === 0) {
    lines.push('- No explicit competing hypotheses were pre-registered.')
  } else {
    for (const h of bundle.hypotheses) {
      lines.push(
        `- **${h.id}** [${h.selected ? 'selected' : 'unselected'}, unit=\`${h.statisticalUnit}\`, verdict=\`${h.verdict}\`]: ${h.statement}${
          h.falsificationCriteria ? ` *(Falsification: ${h.falsificationCriteria})*` : ''
        }`
      )
    }
  }

  lines.push('', '## 2. Study Design, Step Execution & Quality Control Flow')
  return lines.join('\n')
}

function assembleMarkdown(
  state: PlanRunState,
  bundle: Omit<PlanProvenanceReportBundle, 'markdown'>
): string {
  const header = renderProvenanceMarkdown(bundle)
  const stepLines = state.spec.steps.map((s) => formatStepLine(s, state))
  const metricLines =
    bundle.keyMetrics.length === 0
      ? ['- No structured quantitative keyMetrics recorded.']
      : bundle.keyMetrics.map(
          (m) =>
            `- **${m.name}** (step \`${m.stepId}\`): \`${m.value}\`${m.column ? ` [col: \`${m.column}\`]` : ''} ${m.anchor}`
        )
  const auditLines = [
    '## 4. Sensitivity Analyses, Confounders & Epistemic Audit',
    `- **Analysis Mode**: \`${bundle.epistemicAudit.isExploratoryPostHoc ? 'post-hoc exploratory (replanned)' : 'pre-registered confirmatory'}\``,
    `- **Confounders Checked**: ${bundle.confoundersChecked.length > 0 ? bundle.confoundersChecked.map((c) => `\`${c}\``).join(', ') : 'none explicitly declared'}`,
    ...(bundle.epistemicAudit.warnings.length > 0
      ? bundle.epistemicAudit.warnings.map((w) => `- **Warning**: ${w}`)
      : ['- **Audit Warnings**: none'])
  ]
  const methodsLines = renderMethodsSection(
    bundle.phiVersion,
    bundle.wrapperRuns,
    bundle.notebooks,
    bundle.artifacts
  )
  return [
    header,
    ...stepLines,
    '',
    '## 3. Primary Findings, Hypothesis Verdicts & Grounded Metrics',
    ...metricLines,
    '',
    ...auditLines,
    '',
    ...methodsLines,
    ''
  ].join('\n')
}

/**
 * Deterministically compiles a provenance-bound scientific report and Online Methods summary
 * strictly from persisted `PlanRunState`, workspace `.phi-context.json` sidecars, `.ipynb`
 * execution metadata, and frozen `WrapperReproducibilityBundle` snapshots.
 * Never fabricates software versions: unrecorded fields are explicitly reported as `unknown`.
 */
export function compilePlanProvenanceReport(
  input: CompilePlanProvenanceReportInput
): PlanProvenanceReportBundle {
  let realRoot: string | undefined
  if (input.projectRoot) {
    try {
      realRoot = realpathSync(resolve(input.projectRoot))
    } catch {
      realRoot = undefined
    }
  }
  const phiVersion = input.phiVersion?.trim() || 'unknown'
  const artifactPaths = collectReferencedArtifactPaths(input.state)
  const artifacts = artifactPaths.map((relPath) => buildArtifactRecord(relPath, realRoot))
  const anchorByPath = new Map(artifacts.map((a) => [a.path, a.anchor]))

  const notebooks = artifacts
    .map((art) => inspectNotebookProvenance(art.path, realRoot, art.contentSha256))
    .filter((nb): nb is ProvenanceNotebookRecord => nb !== undefined)

  const wrapperIds = collectWrapperRunIds(input.state, input.wrapperRunIds)
  const wrapperRuns = wrapperIds
    .map((id) => inspectWrapperRunProvenance(id, input.agentDir))
    .filter((wr): wr is ProvenanceWrapperRunRecord => wr !== undefined)

  const hypotheses = aggregateHypotheses(input.state)
  const { keyMetrics, confoundersChecked } = collectMetricsAndConfounders(input.state, anchorByPath)
  const epistemicAudit = buildEpistemicAudit(input.state, hypotheses, notebooks, wrapperRuns)

  const base: Omit<PlanProvenanceReportBundle, 'markdown'> = {
    compiledAt: new Date().toISOString(),
    phiVersion,
    runId: input.state.id,
    sessionId: input.state.sessionId,
    goal: input.state.spec.goal,
    ...(input.state.spec.researchQuestion
      ? { researchQuestion: input.state.spec.researchQuestion }
      : {}),
    status: input.state.status,
    hypotheses,
    artifacts,
    wrapperRuns,
    notebooks,
    keyMetrics,
    confoundersChecked,
    epistemicAudit
  }

  return {
    ...base,
    markdown: assembleMarkdown(input.state, base)
  }
}
