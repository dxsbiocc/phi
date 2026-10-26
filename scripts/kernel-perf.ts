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

export const K0_LEGACY_WORKLOAD =
  'one small notes.txt; skills disabled; no MCP; 4 sessions created sequentially in one worker, each performing a read turn; peak from 3 runs'

export function fourSessionWorkload(files: number, rounds: number): string {
  return `${files} files; skills enabled; one stdio MCP per session; ${rounds} rounds of 4 concurrent sessions and loopback turns`
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
    /** Peak-RSS process tree, including the kernel root. */
    readonly processTree: ReadonlyArray<{
      pid: number
      ppid: number
      rssMb: number
      command: string
    }>
    readonly activeProcessTree: ReadonlyArray<{
      pid: number
      ppid: number
      rssMb: number
      command: string
    }>
    readonly idleProcessTree: ReadonlyArray<{
      pid: number
      ppid: number
      rssMb: number
      command: string
    }>
    readonly mcpSessionsVerified: number
  }>
  readonly legacy: {
    readonly k0BaselineMb: number | null
    readonly k0Workload: string
    readonly sameRunFourSessionMb: number | null
    readonly sameRunWorkload: string
    readonly sameRunFailure: string | null
    readonly sameRunProcessTree: ReadonlyArray<{
      pid: number
      ppid: number
      rssMb: number
      command: string
    }>
    readonly sameRunMcpSessionsVerified: number
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

function markdownTableCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\r?\n/gu, '<br>')
}

export function renderKernelPerfMarkdown(report: KernelPerfReport): string {
  const workloadRows =
    report.workloads.length > 0
      ? report.workloads
          .map(
            (workload) =>
              `| ${workload.sessions} | ${workload.rounds} | ${workload.peakRssMb ?? 'not measured'} | ${workload.idleReleasedRssMb ?? 'not measured'} | ${summary(workload.modelNetworkMs, 'ms')} | ${workload.processTree.length} | ${workload.idleProcessTree.length} | ${workload.mcpSessionsVerified} |`
          )
          .join('\n')
      : '| not measured | not measured | not measured | not measured | not measured | not measured | not measured | not measured |'
  const fourSession = report.workloads.find((workload) => workload.sessions === 4)
  const sameRunLegacy =
    report.legacy.sameRunFourSessionMb === null
      ? `not measured — ${markdownTableCell(report.legacy.sameRunFailure ?? 'reason unavailable')}`
      : `${report.legacy.sameRunFourSessionMb} MiB`
  const processRows = [
    ...report.workloads.flatMap((workload) =>
      [
        ['peak', workload.processTree] as const,
        ['active MCP verification', workload.activeProcessTree] as const,
        ['idle release', workload.idleProcessTree] as const
      ].flatMap(([phase, processes]) =>
        processes.map(
          (process) =>
            `| ${workload.sessions} | ${phase} | ${process.pid} | ${process.ppid} | ${process.rssMb} | \`${markdownTableCell(process.command.replaceAll('`', "'"))}\` |`
        )
      )
    ),
    ...report.legacy.sameRunProcessTree.map(
      (process) =>
        `| legacy 4 | peak | ${process.pid} | ${process.ppid} | ${process.rssMb} | \`${markdownTableCell(process.command.replaceAll('`', "'"))}\` |`
    )
  ].join('\n')
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

| Sessions | Rounds | Peak RSS MiB | RSS after idle release MiB | Loopback model time | Peak processes | Idle processes | MCP sessions verified |
| ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
${workloadRows}

| Comparison | Workload | Peak RSS |
| --- | --- | ---: |
| K0-2 recorded legacy baseline | ${report.legacy.k0Workload} | ${report.legacy.k0BaselineMb ?? 'not measured'} MiB |
| Current kernel | ${report.project.files} files; skills enabled; one stdio MCP per session; ${fourSession?.rounds ?? 'not measured'} rounds of 4 concurrent sessions | ${fourSession?.peakRssMb ?? 'not measured'} MiB |
| Same-run legacy route | ${report.legacy.sameRunWorkload} | ${sameRunLegacy} |

- Same-run legacy MCP sessions verified: ${report.legacy.sameRunMcpSessionsVerified}

| Budget line | Result | Measured | Limit |
| --- | --- | --- | --- |
${report.budgets.map((line) => `| ${line.line} | ${line.status} | ${line.measured} | ${line.limit} |`).join('\n')}

## Recorded process trees

| Sessions | Phase | PID | PPID | RSS MiB | Command |
| ---: | --- | ---: | ---: | ---: | --- |
${processRows || '| not measured | not measured | not measured | not measured | not measured | not measured |'}

- Memory tool: local \`ps -A -o pid=,ppid=,rss=,command=\`; remote same-user \`ps -u "$(id -u)" -o pid= -o ppid= -o rss= -o args=\`; both retain only the kernel root and descendants. RSS is reported, not claimed as physical incremental memory.
- Cleanup: ${report.cleanup.complete ? 'complete' : `incomplete (${report.cleanup.remainingProcesses.join(', ') || 'unknown'})`}
${report.failure ? `- Failure: ${report.failure}\n` : ''}`
}

if (import.meta.main) {
  const { runKernelPerformanceCli } = await import('./kernel-perf/runner')
  await runKernelPerformanceCli(process.argv.slice(2))
}
