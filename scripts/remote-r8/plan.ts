import { CASE_MS, CASE_NAMES, REMOTE_WORK_PARENT, SCRATCH_DIRECTORY, TOTAL_MS } from './types'
import type { R8Args } from './args'

export interface R8Plan {
  readonly mode: 'plan-only'
  readonly executed: false
  readonly host: string
  readonly runtimeRoot: string
  readonly runtimeRootExplicit: boolean
  readonly commit: string
  readonly trackedFilesModified: number
  readonly bundleHash: string
  readonly ompVersion: string
  readonly connects: readonly string[]
  readonly creates: readonly string[]
  readonly removes: readonly string[]
  readonly retains: readonly string[]
  readonly cases: readonly { readonly name: string; readonly budgetMs: number }[]
  readonly totalBudgetMs: number
  readonly startsNothing: string
}

export interface R8PlanFacts {
  readonly commit: string
  readonly trackedFilesModified: number
  readonly bundleHash: string
  readonly ompVersion: string
}

export function buildPlan(args: R8Args, facts: R8PlanFacts): R8Plan {
  const root = args.runtimeRoot
  const work = `${root}/${REMOTE_WORK_PARENT}/<run-id>`
  return {
    mode: 'plan-only',
    executed: false,
    host: args.host,
    runtimeRoot: root,
    runtimeRootExplicit: args.runtimeRootExplicit,
    ...facts,
    connects: [
      `ssh ${args.host}: one OpenSSH master per runtime generation (the first run, then the recovery run)`,
      'a reverse tunnel from the server to a loopback synthetic model provider on this machine',
      'the production startup transaction installs anything missing on the server: OMP binary, Phi extension, remote helper'
    ],
    creates: [
      `server: ${root} when it does not exist (mode 0700; an existing root must pass the ownership checks)`,
      `server: ${work}/project with one seed file and an owner token`,
      `server: ${root}/rpc-sessions/<nonce> and the durable synthetic session journal (production-owned)`,
      `local: ${SCRATCH_DIRECTORY}/runs/<run-id>/{home,agent,tmp} (private HOME, agent dir, synthetic auth)`,
      `local: ${SCRATCH_DIRECTORY}/receipts/<timestamp>-${args.host}-<run-id>.json`
    ],
    removes: [
      `server: ${work} (only after the owner token, UID, mode, link-count and canonical-path checks)`,
      `server: every attested ${root}/rpc-sessions/<nonce> (confirmed gone, never force-removed)`,
      `local: ${SCRATCH_DIRECTORY}/runs/<run-id>/agent/cache (downloaded OMP asset)`
    ],
    retains: [
      `server: ${root} with the installed binary, extension and helper; durable synthetic journals`,
      'local: the receipt; the run directory is kept when the run or its cleanup failed'
    ],
    cases: CASE_NAMES.map((name) => ({ name, budgetMs: CASE_MS })),
    totalBudgetMs: TOTAL_MS,
    startsNothing: 'Plan mode starts no SSH, SDK, provider or model process.'
  }
}

export function renderPlan(plan: R8Plan): string {
  const list = (items: readonly string[]): string[] => items.map((item) => `  - ${item}`)
  return [
    `Remote R8 acceptance plan for host "${plan.host}" (not executed)`,
    '',
    `Commit:          ${plan.commit}${plan.trackedFilesModified ? `  (${plan.trackedFilesModified} tracked file(s) modified: --execute would refuse)` : ''}`,
    `Extension bundle: ${plan.bundleHash}`,
    `OMP version:     ${plan.ompVersion}`,
    `Runtime root:    ${plan.runtimeRoot}${plan.runtimeRootExplicit ? '' : ' (default)'}`,
    '',
    'Would connect to:',
    ...list(plan.connects),
    'Would create:',
    ...list(plan.creates),
    'Would remove:',
    ...list(plan.removes),
    'Would keep:',
    ...list(plan.retains),
    '',
    'Cases (each bounded to 120 s, whole run to 15 min):',
    ...plan.cases.map((entry, index) => `  ${index + 1}. ${entry.name}`),
    '',
    plan.startsNothing,
    'Add --execute to run it for real.'
  ].join('\n')
}
