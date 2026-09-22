#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Summarises what delegated agent runs (Database, Wrapper, Visualization, ...) cost:
// tokens, model calls, tool calls and their result sizes, and the fixed price of the
// first turn. Reads the records Phi writes to <agent dir>/telemetry/.
//
// Usage (needs the TS loader, so go through the npm script):
//   npm run usage:report                       # last 7 days, all agents
//   npm run usage:report -- --days 1           # last day
//   npm run usage:report -- --agent Database   # one agent
//   npm run usage:report -- --dir /path/.phi   # another agent dir
//   npm run usage:report -- --json             # machine-readable summary
//
// To judge a change: run a fixed set of tasks before and after and compare the two reports.

import { getPhiAgentDir } from '../src/main/agent/runtime-paths'
import { readAgentUsageRecords } from '../src/main/agent/agents/usage-log'
import { formatUsageReport, summarizeUsage } from '../src/main/agent/agents/usage-report'

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const days = Number(option('days', '7'))
if (!Number.isFinite(days) || days <= 0) {
  console.error('--days must be a positive number')
  process.exit(2)
}
const agentDir = option('dir', getPhiAgentDir())
const agent = option('agent', undefined)
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

const records = readAgentUsageRecords(agentDir, { since }).filter(
  (record) => (!agent || record.agent === agent) && Date.parse(record.timestamp) >= since.getTime()
)
const summary = summarizeUsage(records)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log(`${records.length} run(s) since ${since.toISOString().slice(0, 10)} in ${agentDir}\n`)
  console.log(formatUsageReport(summary))
}
