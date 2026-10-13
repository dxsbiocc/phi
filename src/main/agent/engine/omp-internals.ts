// Single review surface for non-MCP OMP internals during OMP upgrades.

import type { Model as OmpModel } from '@oh-my-pi/pi-ai/types'
import { authPolicyFor as ompAuthPolicyFor } from '@oh-my-pi/pi-catalog/compat/auth'
import { getCatalogProviderEntry as ompGetCatalogProviderEntry } from '@oh-my-pi/pi-catalog/provider-models/descriptors'
import { applyProviderGlobalsFromSettings as ompApplyProviderGlobalsFromSettings } from '@oh-my-pi/pi-coding-agent/config/provider-globals'
import {
  getMemoryRoot as ompGetMemoryRoot,
  saveLearnedLesson as ompSaveLearnedLesson
} from '@oh-my-pi/pi-coding-agent/memories'
import {
  closeMemoryDb as ompCloseMemoryDb,
  openMemoryDb as ompOpenMemoryDb
} from '@oh-my-pi/pi-coding-agent/memories/storage'
import { estimateToolSchemaTokens as ompEstimateToolSchemaTokens } from '@oh-my-pi/pi-coding-agent/modes/utils/context-usage'
import { resolveApprovedPlan as ompResolveApprovedPlan } from '@oh-my-pi/pi-coding-agent/plan-mode/approved-plan'
import {
  listPlanFiles as ompListPlanFiles,
  readPlanFile as ompReadPlanFile
} from '@oh-my-pi/pi-coding-agent/plan-mode/plan-files'
import {
  DEFAULT_COMPACTION_METHOD_ORDER as OMP_DEFAULT_COMPACTION_METHOD_ORDER,
  resolveCompactionMethodOrder as ompResolveCompactionMethodOrder
} from '@oh-my-pi/pi-coding-agent/session/compaction-methods'
import {
  parseConfiguredThinkingLevel as ompParseConfiguredThinkingLevel,
  type ConfiguredThinkingLevel as OmpConfiguredThinkingLevel
} from '@oh-my-pi/pi-coding-agent/thinking'
import { getAgentDbPath as ompGetAgentDbPath } from '@oh-my-pi/pi-utils'

import type { PhiCompactionMethod } from './types'

type AssertAssignable<Actual extends Expected, Expected> = Actual

export interface PhiToolSchemaForTokenEstimate {
  name: string
  description: string
  parameters: unknown
}

export interface PhiTokenizer {
  countTokens(text: string | string[]): number
}

export function estimateToolSchemaTokens(
  tools: readonly PhiToolSchemaForTokenEstimate[],
  tokenizer: PhiTokenizer
): number {
  return ompEstimateToolSchemaTokens(
    tools as Parameters<typeof ompEstimateToolSchemaTokens>[0],
    tokenizer as Parameters<typeof ompEstimateToolSchemaTokens>[1]
  )
}

export type ConfiguredThinkingLevel =
  'inherit' | 'off' | 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export function parseConfiguredThinkingLevel(
  value: string | null | undefined
): ConfiguredThinkingLevel | undefined {
  return ompParseConfiguredThinkingLevel(value)
}

export interface PhiProviderGlobalSettings {
  get(
    path: 'providers.webSearchOrder' | 'providers.webSearchExclude' | 'providers.imageOrder'
  ): unknown
}

export function applyProviderGlobalsFromSettings(settings: PhiProviderGlobalSettings): void {
  ompApplyProviderGlobalsFromSettings(settings)
}

export type PhiAuthLoginKind = 'api-key' | 'oauth-code' | 'device-code' | 'custom'

export interface PhiAuthPolicy {
  id: string
  name: string
  result?: 'api-key'
  login?: { kind: PhiAuthLoginKind }
}

type OmpAuthPolicy = NonNullable<ReturnType<typeof ompAuthPolicyFor>>

export function authPolicyFor(providerId: string): PhiAuthPolicy | undefined {
  return ompAuthPolicyFor(providerId)
}

export interface PhiCatalogProviderEntry {
  id: string
  defaultModel: string
  envVars?: readonly string[]
  catalogDiscovery?: { label: string }
}

type OmpCatalogProviderEntry = NonNullable<ReturnType<typeof ompGetCatalogProviderEntry>>

export function getCatalogProviderEntry(providerId: string): PhiCatalogProviderEntry | undefined {
  return ompGetCatalogProviderEntry(providerId)
}

export interface PhiLocalProtocolOptions {
  getArtifactsDir?: () => string | null
  getSessionId?: () => string | null
}

export interface PhiResolveApprovedPlanInput {
  suppliedTitle?: unknown
  statePlanFilePath: string
  readPlan(planUrl: string): Promise<string | null>
  listPlanFiles?: () => Promise<string[]>
}

export interface PhiResolvedApprovedPlan {
  planFilePath: string
  planContent: string
  title: string
}

type OmpResolveApprovedPlanInput = Parameters<typeof ompResolveApprovedPlan>[0]
type OmpResolvedApprovedPlan = Awaited<ReturnType<typeof ompResolveApprovedPlan>>

export function resolveApprovedPlan(
  input: PhiResolveApprovedPlanInput
): Promise<PhiResolvedApprovedPlan> {
  return ompResolveApprovedPlan(input)
}

export function listPlanFiles(options: {
  localProtocolOptions: PhiLocalProtocolOptions
}): Promise<string[]> {
  return ompListPlanFiles(options)
}

export function readPlanFile(
  planFilePath: string,
  options: { localProtocolOptions: PhiLocalProtocolOptions; cwd: string }
): Promise<string | null> {
  return ompReadPlanFile(planFilePath, options)
}

type OmpCompactionMethod = (typeof OMP_DEFAULT_COMPACTION_METHOD_ORDER)[number]

export const DEFAULT_COMPACTION_METHOD_ORDER: readonly PhiCompactionMethod[] =
  OMP_DEFAULT_COMPACTION_METHOD_ORDER

export function resolveCompactionMethodOrder(value: unknown): PhiCompactionMethod[] {
  return ompResolveCompactionMethodOrder(value)
}

export interface PhiModel {
  id: string
  provider: string
  name: string
  reasoning: boolean
  input: Array<'text' | 'image'>
  thinking?: { efforts: readonly string[] }
}

export type PhiMemoryBackendId = 'off' | 'local' | 'hindsight' | 'mnemopi' | 'sharpshooter'

export interface PhiMemorySaveInput {
  content: string
  context?: string
  source?: string
  importance?: number
}

export interface PhiMemorySaveResult {
  backend: PhiMemoryBackendId
  stored: number
  ids?: string[]
  queued?: boolean
  message?: string
}

type OmpMemorySaveInput = Parameters<typeof ompSaveLearnedLesson>[2]
type OmpMemorySaveResult = Awaited<ReturnType<typeof ompSaveLearnedLesson>>

export interface PhiMemoryStatement {
  run(...bindings: Array<string | number | bigint | null>): unknown
}

export interface PhiMemoryDatabase {
  prepare(query: string): PhiMemoryStatement
  transaction<T>(callback: () => T): () => T
}

type OmpMemoryDatabase = ReturnType<typeof ompOpenMemoryDb>
type OmpConfiguredThinkingLevelValue = `${OmpConfiguredThinkingLevel}`
type OmpTypeCompatibilityChecks = [
  AssertAssignable<OmpConfiguredThinkingLevelValue, ConfiguredThinkingLevel>,
  AssertAssignable<ConfiguredThinkingLevel, OmpConfiguredThinkingLevelValue>,
  AssertAssignable<OmpAuthPolicy, PhiAuthPolicy>,
  AssertAssignable<OmpCatalogProviderEntry, PhiCatalogProviderEntry>,
  AssertAssignable<PhiResolveApprovedPlanInput, OmpResolveApprovedPlanInput>,
  AssertAssignable<OmpResolveApprovedPlanInput, PhiResolveApprovedPlanInput>,
  AssertAssignable<OmpResolvedApprovedPlan, PhiResolvedApprovedPlan>,
  AssertAssignable<OmpCompactionMethod, PhiCompactionMethod>,
  AssertAssignable<PhiCompactionMethod, OmpCompactionMethod>,
  AssertAssignable<OmpModel, PhiModel>,
  AssertAssignable<OmpMemorySaveInput, PhiMemorySaveInput>,
  AssertAssignable<PhiMemorySaveInput, OmpMemorySaveInput>,
  AssertAssignable<OmpMemorySaveResult, PhiMemorySaveResult>,
  AssertAssignable<OmpMemoryDatabase, PhiMemoryDatabase>
]
const ompTypeCompatibilityChecks: OmpTypeCompatibilityChecks | undefined = undefined
void ompTypeCompatibilityChecks

export function getMemoryRoot(agentDir: string, cwd: string): string {
  return ompGetMemoryRoot(agentDir, cwd)
}

export function saveLearnedLesson(
  agentDir: string,
  cwd: string,
  input: PhiMemorySaveInput
): Promise<PhiMemorySaveResult> {
  return ompSaveLearnedLesson(agentDir, cwd, input)
}

export function openMemoryDb(dbPath: string): PhiMemoryDatabase {
  return ompOpenMemoryDb(dbPath)
}

export function closeMemoryDb(db: PhiMemoryDatabase): void {
  ompCloseMemoryDb(db as unknown as OmpMemoryDatabase)
}

export function getAgentDbPath(agentDir?: string): string {
  return ompGetAgentDbPath(agentDir)
}
