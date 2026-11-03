import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

import type { CliOptions, DryRunProbe, ScenarioResult } from './types'

export interface ReportInput {
  options: CliOptions
  launchMode: 'electron' | 'cdp'
  results: ScenarioResult[]
  probes?: DryRunProbe[]
  unmatchedServers: string[]
  isolatedHomeRetained: boolean
}

const SECRET_PATTERNS = [
  /\b(?:api[\s_-]?key|token|secret|password)\s*[:=]\s*\S+/gi,
  /\bBearer\s+\S+/gi,
  /\b(?:sk|xai|key|token)-[A-Za-z0-9_-]{8,}\b/gi,
  /\b(?:ghp_|github_pat_|glpat-|hf_)[A-Za-z0-9_-]{12,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g
]

export function redactEvidence(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), value)
}

function safeCell(value: string): string {
  return redactEvidence(value).replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function resultRow(result: ScenarioResult): string {
  const evidence = [
    ...(result.reason ? [`reason: ${result.reason}`] : []),
    ...result.evidence.map(redactEvidence)
  ].join('; ')
  return `| ${result.name} | ${result.status} | ${result.durationMs} | ${result.modelRequests} | ${safeCell(evidence)} |`
}

function probeLines(probes: DryRunProbe[] | undefined): string[] {
  if (!probes) return []
  return [
    '',
    '## Dry-run selector probes',
    '',
    '| Selector | State | CSS |',
    '|---|---|---|',
    ...probes.map((probe) => `| ${safeCell(probe.name)} | ${probe.state} | \`${probe.selector}\` |`)
  ]
}

function reportMarkdown(input: ReportInput): string {
  const used = input.results.reduce((sum, result) => sum + result.modelRequests, 0)
  const lines = [
    '# Phi packaged GUI acceptance report',
    '',
    `- Mode: ${input.options.dryRun ? 'dry-run' : 'real-server acceptance'}`,
    `- Launch: ${input.launchMode}`,
    `- App: ${basename(input.options.app)}`,
    `- Model request ceiling: ${input.options.maxRequests}`,
    `- Requests observed across scenario windows: ${used}`,
    `- Isolated HOME retained: ${input.isolatedHomeRetained ? 'yes' : 'no'}`,
    ...(input.unmatchedServers.length > 0
      ? [`- Unmatched server selectors: ${input.unmatchedServers.map(safeCell).join(', ')}`]
      : []),
    '',
    '| Scenario | Result | Duration (ms) | Model requests | Evidence |',
    '|---|---:|---:|---:|---|',
    ...input.results.map(resultRow),
    ...probeLines(input.probes),
    '',
    '## Request counter',
    '',
    'The harness counts unique assistant response commits in the isolated Phi session journals, model fallback records, and automatic-title attempts. ' +
      'Events `assistant_thinking_completed`, `assistant_message_finalized`, and `tool_call_started` ' +
      'from the same `(runId, createdAt)` are one model response; a later tool-loop response has a ' +
      'different timestamp and increments the count. Successful title attempts come from the stable ' +
      'session manifest marker; failed title attempts come from the redacted app log. This counts model ' +
      'calls rather than prompts without reading or reporting message content. A failed run with no ' +
      'assistant commit is conservatively counted as one request so failures cannot weaken the ceiling.',
    ''
  ]
  return `${lines.join('\n')}\n`
}

function sanitizedResults(results: ScenarioResult[]): ScenarioResult[] {
  return results.map((result) => ({
    ...result,
    evidence: result.evidence.map(redactEvidence),
    ...(result.reason ? { reason: redactEvidence(result.reason) } : {})
  }))
}

export function writeReport(input: ReportInput): void {
  mkdirSync(input.options.reportDir, { recursive: true })
  mkdirSync(join(input.options.reportDir, 'screenshots'), { recursive: true })
  const json = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dryRun: input.options.dryRun,
    launchMode: input.launchMode,
    app: input.options.app,
    maxRequests: input.options.maxRequests,
    scenarios: sanitizedResults(input.results),
    probes: input.probes ?? [],
    unmatchedServers: input.unmatchedServers,
    isolatedHomeRetained: input.isolatedHomeRetained
  }
  writeFileSync(join(input.options.reportDir, 'report.json'), `${JSON.stringify(json, null, 2)}\n`)
  writeFileSync(join(input.options.reportDir, 'report.md'), reportMarkdown(input))
}

export function reportScreenshotPath(reportDir: string, name: string): string {
  return join(reportDir, 'screenshots', `${name}.png`)
}

export function relativeScreenshot(reportDir: string, screenshot: string): string {
  return relative(reportDir, screenshot)
}
