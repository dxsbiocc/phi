import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Per-trial research cost, token, runtime/queue-wait, and human intervention ledger (R16).
 *
 * Key invariants:
 * - Calls are deduplicated by `callId` across main agent, subagents, decisions, and retries.
 * - Real `0` tokens are strictly distinguished from missing/unavailable (`null` + `unknownReason`).
 * - Pricing tables are versioned and dated; runtime is separated from cluster queue wait.
 * - Human intervention records explicitly distinguish `unattended` vs `unrecorded` vs `intervened`.
 * - Persistence failures propagate as explicit errors (marking evidence integrity failed) and
 *   are never silently swallowed.
 */

export type LedgerCallRole = 'main_agent' | 'subagent' | 'decision' | 'retry'

export interface TrialUsageCallRecord {
  callId: string
  trialId: string
  role: LedgerCallRole
  model: string
  /** Real token count (including 0), or `null` when unavailable from provider. */
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  unknownReason?: string
  /** Active execution duration in ms (excludes scheduler queue wait). */
  runDurationMs: number
  /** Optional HPC/scheduler queue wait time in ms. */
  queueWaitMs?: number
  timestamp: string
}

export interface ModelPriceRate {
  inputPerMillionUsd: number
  outputPerMillionUsd: number
  cacheReadPerMillionUsd?: number
  cacheWritePerMillionUsd?: number
}

export interface PriceTable {
  version: string
  effectiveDate: string
  rates: Record<string, ModelPriceRate>
}

export interface TrialCostSummary {
  trialId: string
  priceTableVersion: string
  priceTableEffectiveDate: string
  callCount: number
  callsByRole: Record<LedgerCallRole, number>
  /** Sum of known tokens; `null` if any call had missing/unknown counts for that field. */
  totalInputTokens: number | null
  totalOutputTokens: number | null
  unknownTokenCalls: number
  totalRunDurationMs: number
  totalQueueWaitMs: number
  /** Exact USD estimate when all calls have known tokens and rates; `null` otherwise. */
  estimatedCostUsd: number | null
  costCompleteness: 'complete' | 'partial' | 'unknown'
  calls: TrialUsageCallRecord[]
}

export interface HumanInterventionEvent {
  timestamp: string
  durationSeconds: number
  reason: string
  action: string
}

export interface HumanInterventionLedger {
  trialId: string
  /** Explicitly separates zero-intervention unattended runs from runs where interventions were not tracked. */
  trackingStatus: 'unattended' | 'intervened' | 'unrecorded'
  totalDurationSeconds: number
  events: HumanInterventionEvent[]
}

export class TrialCostLedger {
  private readonly callsById = new Map<string, TrialUsageCallRecord>()

  constructor(private readonly trialId: string) {}

  recordCall(entry: TrialUsageCallRecord): void {
    if (entry.trialId !== this.trialId) {
      throw new Error(`Call "${entry.callId}" belongs to trial "${entry.trialId}", not "${this.trialId}"`)
    }
    if (this.callsById.has(entry.callId)) return
    this.callsById.set(entry.callId, { ...entry })
  }

  summarize(priceTable: PriceTable): TrialCostSummary {
    const calls = [...this.callsById.values()]
    const callsByRole: Record<LedgerCallRole, number> = {
      main_agent: 0,
      subagent: 0,
      decision: 0,
      retry: 0
    }
    let inputSum = 0
    let outputSum = 0
    let anyInputUnknown = false
    let anyOutputUnknown = false
    let unknownTokenCalls = 0
    let totalRunDurationMs = 0
    let totalQueueWaitMs = 0
    let pricedCalls = 0
    let costUsd = 0

    for (const call of calls) {
      callsByRole[call.role] += 1
      totalRunDurationMs += Math.max(0, call.runDurationMs)
      totalQueueWaitMs += Math.max(0, call.queueWaitMs ?? 0)

      const hasInput = typeof call.inputTokens === 'number' && Number.isFinite(call.inputTokens)
      const hasOutput = typeof call.outputTokens === 'number' && Number.isFinite(call.outputTokens)
      if (hasInput) inputSum += call.inputTokens!
      else anyInputUnknown = true
      if (hasOutput) outputSum += call.outputTokens!
      else anyOutputUnknown = true
      if (!hasInput || !hasOutput) {
        unknownTokenCalls += 1
        continue
      }

      const rate = priceTable.rates[call.model]
      if (rate) {
        pricedCalls += 1
        costUsd += (call.inputTokens! / 1_000_000) * rate.inputPerMillionUsd
        costUsd += (call.outputTokens! / 1_000_000) * rate.outputPerMillionUsd
        if (call.cacheReadTokens && rate.cacheReadPerMillionUsd) {
          costUsd += (call.cacheReadTokens / 1_000_000) * rate.cacheReadPerMillionUsd
        }
        if (call.cacheWriteTokens && rate.cacheWritePerMillionUsd) {
          costUsd += (call.cacheWriteTokens / 1_000_000) * rate.cacheWritePerMillionUsd
        }
      }
    }

    const costCompleteness: TrialCostSummary['costCompleteness'] =
      calls.length === 0 || pricedCalls === calls.length
        ? 'complete'
        : pricedCalls > 0
          ? 'partial'
          : 'unknown'

    return {
      trialId: this.trialId,
      priceTableVersion: priceTable.version,
      priceTableEffectiveDate: priceTable.effectiveDate,
      callCount: calls.length,
      callsByRole,
      totalInputTokens: anyInputUnknown ? null : inputSum,
      totalOutputTokens: anyOutputUnknown ? null : outputSum,
      unknownTokenCalls,
      totalRunDurationMs,
      totalQueueWaitMs,
      estimatedCostUsd: costCompleteness === 'complete' ? Number(costUsd.toFixed(6)) : null,
      costCompleteness,
      calls
    }
  }
}

export function createHumanInterventionLedger(
  trialId: string,
  events: readonly HumanInterventionEvent[] | 'unrecorded'
): HumanInterventionLedger {
  if (events === 'unrecorded') {
    return { trialId, trackingStatus: 'unrecorded', totalDurationSeconds: 0, events: [] }
  }
  const totalDurationSeconds = events.reduce((sum, e) => sum + Math.max(0, e.durationSeconds), 0)
  return {
    trialId,
    trackingStatus: events.length === 0 ? 'unattended' : 'intervened',
    totalDurationSeconds,
    events: [...events]
  }
}

/**
 * Persists both cost and intervention ledgers; throws on any write failure so
 * evidence-integrity failure is never silently swallowed.
 */
export function persistTrialLedgers(
  paths: { usageJson: string; interventionsJson: string },
  costSummary: TrialCostSummary,
  interventions: HumanInterventionLedger
): void {
  mkdirSync(dirname(paths.usageJson), { recursive: true })
  mkdirSync(dirname(paths.interventionsJson), { recursive: true })
  writeFileSync(paths.usageJson, `${JSON.stringify(costSummary, null, 2)}\n`, 'utf-8')
  writeFileSync(paths.interventionsJson, `${JSON.stringify(interventions, null, 2)}\n`, 'utf-8')
}
