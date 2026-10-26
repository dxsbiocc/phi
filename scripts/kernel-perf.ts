#!/usr/bin/env bun

export type PerfBudgetStatus = 'PASS' | 'FAIL' | 'not measured'

export interface PerfBudgetLine {
  readonly line: string
  readonly status: PerfBudgetStatus
  readonly measured: string
  readonly limit: string
}

export interface PercentileSummary {
  readonly n: number
  readonly p50: number
  readonly p95: number
  readonly max: number
}

export interface KernelPerfReport {
  readonly schemaVersion: 1
  readonly candidateId: string
  readonly target: 'local' | 'ssh'
  readonly host?: string
  readonly measuredAt: string
  readonly machine: {
    readonly os: string
    readonly arch: string
    readonly node: string
    readonly bun: string
  }
  readonly versions: { readonly phi: string; readonly omp: string; readonly native: string }
  readonly project: {
    readonly files: number
    readonly skills: boolean
    readonly stdioMcpPerSession: boolean
  }
  readonly ready: null | {
    readonly definition: string
    readonly warm: true
    readonly kernel: PercentileSummary
    readonly firstSession: PercentileSummary
  }
  readonly workloads: ReadonlyArray<{
    readonly sessions: 1 | 4
    readonly rounds: number
    readonly peakRssMb: number | null
    readonly idleReleasedRssMb: number | null
    readonly modelNetworkMs: PercentileSummary | null
    readonly processTree: ReadonlyArray<{
      pid: number
      ppid: number
      rssMb: number
      command: string
    }>
  }>
  readonly legacy: {
    readonly k0BaselineMb: number | null
    readonly sameRunFourSessionMb: number | null
  }
  readonly budgets: readonly PerfBudgetLine[]
  readonly cleanup: { readonly complete: boolean; readonly remainingProcesses: readonly number[] }
  readonly failure?: string
}

export function percentileSummary(values: readonly number[]): PercentileSummary {
  if (values.length === 0) throw new Error('Cannot summarize an empty performance sample.')
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (value: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil((value / 100) * sorted.length) - 1)]
  return {
    n: sorted.length,
    p50: Math.round(percentile(50)),
    p95: Math.round(percentile(95)),
    max: Math.round(sorted.at(-1)!)
  }
}

function budgetLine(
  line: string,
  measured: number | undefined,
  limit: number,
  unit: string,
  pass: (value: number) => boolean
): PerfBudgetLine {
  return measured === undefined
    ? { line, status: 'not measured', measured: 'not measured', limit: `${limit} ${unit}` }
    : {
        line,
        status: pass(measured) ? 'PASS' : 'FAIL',
        measured: `${Math.round(measured)} ${unit}`,
        limit: `${Math.round(limit)} ${unit}`
      }
}

export function evaluateKernelPerfBudget(input: {
  readonly localReadyP95Ms?: number
  readonly fourSessionPeakMb?: number
  readonly legacyBaselineMb?: number
  readonly sameRunLegacyFourSessionMb?: number
}): PerfBudgetLine[] {
  const targetLimit =
    input.legacyBaselineMb === undefined ? undefined : input.legacyBaselineMb * 1.5
  const hardBaselineLimit =
    input.legacyBaselineMb === undefined ? undefined : input.legacyBaselineMb * 2
  const sameRunLimit =
    input.sameRunLegacyFourSessionMb === undefined
      ? undefined
      : input.sameRunLegacyFourSessionMb * 1.5
  return [
    budgetLine(
      'Local warm kernel ready p95',
      input.localReadyP95Ms,
      1_000,
      'ms',
      (value) => value <= 1_000
    ),
    targetLimit === undefined
      ? {
          line: 'Four-session memory target vs K0-2',
          status: 'not measured',
          measured: 'not measured',
          limit: '1.5× K0-2 baseline'
        }
      : budgetLine(
          'Four-session memory target vs K0-2',
          input.fourSessionPeakMb,
          targetLimit,
          'MiB',
          (value) => value <= targetLimit
        ),
    hardBaselineLimit === undefined
      ? {
          line: 'Four-session hard gate vs K0-2',
          status: 'not measured',
          measured: 'not measured',
          limit: '2× K0-2 baseline'
        }
      : budgetLine(
          'Four-session hard gate vs K0-2',
          input.fourSessionPeakMb,
          hardBaselineLimit,
          'MiB',
          (value) => value <= hardBaselineLimit
        ),
    budgetLine(
      'Four-session absolute hard gate',
      input.fourSessionPeakMb,
      1_536,
      'MiB',
      (value) => value <= 1_536
    ),
    sameRunLimit === undefined
      ? {
          line: 'Four-session memory vs same-run legacy route',
          status: 'not measured',
          measured: 'not measured',
          limit: '1.5× same-run legacy'
        }
      : budgetLine(
          'Four-session memory vs same-run legacy route',
          input.fourSessionPeakMb,
          sameRunLimit,
          'MiB',
          (value) => value <= sameRunLimit
        )
  ]
}

function summary(value: PercentileSummary | null, unit: string): string {
  return value
    ? `n=${value.n}; p50=${value.p50} ${unit}; p95=${value.p95} ${unit}; max=${value.max} ${unit}`
    : 'not measured'
}

export function renderKernelPerfMarkdown(report: KernelPerfReport): string {
  const workloadRows =
    report.workloads.length > 0
      ? report.workloads
          .map(
            (workload) =>
              `| ${workload.sessions} | ${workload.rounds} | ${workload.peakRssMb ?? 'not measured'} | ${workload.idleReleasedRssMb ?? 'not measured'} | ${summary(workload.modelNetworkMs, 'ms')} | ${workload.processTree.length} |`
          )
          .join('\n')
      : '| not measured | not measured | not measured | not measured | not measured | not measured |'
  return `# Phi kernel candidate performance

- Candidate: \`${report.candidateId}\`
- Target: ${report.target}${report.host ? ` (${report.host})` : ''}
- Machine/system: ${report.machine.os} ${report.machine.arch}; Node ${report.machine.node}; Bun ${report.machine.bun}
- Versions: Phi ${report.versions.phi}; OMP ${report.versions.omp}; native ${report.versions.native}
- Project scale: ${report.project.files} files; skills ${report.project.skills ? 'enabled' : 'not measured'}; stdio MCP per session ${report.project.stdioMcpPerSession ? 'enabled' : 'not measured'}
- Ready definition: ${report.ready?.definition ?? 'not measured'}
- Warm kernel ready: ${summary(report.ready?.kernel ?? null, 'ms')}
- Warm first-session ready: ${summary(report.ready?.firstSession ?? null, 'ms')}
- Model network/download time is reported separately below and is excluded from ready timing.

| Sessions | Rounds | Peak RSS MiB | RSS after idle release MiB | Loopback model time | Process count |
| ---: | ---: | ---: | ---: | --- | ---: |
${workloadRows}

| Budget line | Result | Measured | Limit |
| --- | --- | --- | --- |
${report.budgets.map((line) => `| ${line.line} | ${line.status} | ${line.measured} | ${line.limit} |`).join('\n')}

- K0-2 legacy four-session baseline: ${report.legacy.k0BaselineMb ?? 'not measured'} MiB
- Same-machine legacy-route four-session peak: ${report.legacy.sameRunFourSessionMb ?? 'not measured'} MiB
- Memory tool: \`ps -A -o pid=,ppid=,rss=,command=\` over the kernel and all descendants; RSS is reported, not claimed as physical incremental memory.
- Cleanup: ${report.cleanup.complete ? 'complete' : `incomplete (${report.cleanup.remainingProcesses.join(', ') || 'unknown'})`}
${report.failure ? `- Failure: ${report.failure}\n` : ''}`
}

if (import.meta.main) {
  const { runKernelPerformanceCli } = await import('./kernel-perf/runner')
  await runKernelPerformanceCli(process.argv.slice(2))
}
