import { resolve } from 'node:path'

import { SCENARIO_NAMES, type CliOptions, type ScenarioName } from './types'

const DEFAULT_SCENARIO_TIMEOUT_MS = 5 * 60_000
const DEFAULT_DEADLINE_MS = 30 * 60_000

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be positive`)
  return parsed
}

function scenarioList(value: string | undefined): ScenarioName[] {
  if (!value) return [...SCENARIO_NAMES]
  const names = value.split(',').map((item) => item.trim())
  const invalid = names.filter((name) => !SCENARIO_NAMES.includes(name as ScenarioName))
  if (invalid.length > 0) throw new Error(`Unknown scenarios: ${invalid.join(', ')}`)
  const selected = new Set(names as ScenarioName[])
  return SCENARIO_NAMES.filter((name) => selected.has(name))
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function defaultReportDir(): string {
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return resolve('.phi-acceptance', 'gui-e2e-report', stamp)
}

export function parseCli(argv: string[]): CliOptions {
  const values = new Map<string, string>()
  const switches = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!
    if (flag === '--') continue
    if (flag === '--dry-run' || flag === '--keep-home') {
      switches.add(flag)
      continue
    }
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`)
    values.set(flag, valueAfter(argv, index, flag))
    index += 1
  }

  const app = values.get('--app')
  if (!app) throw new Error('--app is required')
  const dryRun = switches.has('--dry-run')
  const servers = (values.get('--servers') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const model = values.get('--model') ?? ''
  if (!dryRun && !model) throw new Error('--model is required outside --dry-run')

  return {
    app: resolve(app),
    servers,
    model,
    maxRequests: positiveInteger(values.get('--max-requests') ?? '40', '--max-requests'),
    scenarios: scenarioList(values.get('--scenarios')),
    dryRun,
    keepHome: switches.has('--keep-home'),
    reportDir: resolve(values.get('--report') ?? defaultReportDir()),
    scenarioTimeoutMs: positiveInteger(
      values.get('--scenario-timeout-ms') ?? String(DEFAULT_SCENARIO_TIMEOUT_MS),
      '--scenario-timeout-ms'
    ),
    deadlineMs: positiveInteger(
      values.get('--deadline-ms') ?? String(DEFAULT_DEADLINE_MS),
      '--deadline-ms'
    )
  }
}

export function usage(): string {
  return [
    'Usage: bun run e2e:gui -- --app <Phi.app> [options]',
    '  --servers gpu,yzhang-node3  copied-profile SSH projects',
    '  --model "Grok 4.5 Fast"      exact model display name',
    '  --max-requests 40            hard request ceiling',
    '  --scenarios a,b              selected scenarios',
    '  --dry-run                    selectors only; no remote project or model',
    '  --keep-home                  retain the isolated temporary HOME',
    '  --report <dir>               report.md, report.json, screenshots/',
    '  --scenario-timeout-ms <ms>   per-scenario deadline (default 300000)',
    '  --deadline-ms <ms>           overall deadline (default 1800000)'
  ].join('\n')
}
