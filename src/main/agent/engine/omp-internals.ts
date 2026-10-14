// Single review surface for non-MCP OMP internals during OMP upgrades.

import type { Model as OmpModel } from '@oh-my-pi/pi-ai/types'
import { authPolicyFor as ompAuthPolicyFor } from '@oh-my-pi/pi-catalog/compat/auth'
import { providerEntry as ompGetCatalogProviderEntry } from '@oh-my-pi/pi-catalog/compat/providers'
import {
  getMemoryRoot as ompGetMemoryRoot,
  saveLearnedLesson as ompSaveLearnedLesson
} from '@oh-my-pi/pi-coding-agent/memories'
import {
  closeMemoryDb as ompCloseMemoryDb,
  openMemoryDb as ompOpenMemoryDb
} from '@oh-my-pi/pi-coding-agent/memories/storage'
import { toolWireSchema } from '@oh-my-pi/pi-ai/utils/schema'
import { renderToolExamples } from '@oh-my-pi/pi-ai/dialect'
import type { Tool as OmpTool } from '@oh-my-pi/pi-ai'
import { resolveApprovedPlan as ompResolveApprovedPlan } from '@oh-my-pi/pi-coding-agent/plan-mode/approved-plan'
import {
  listPlanFiles as ompListPlanFiles,
  readPlanFile as ompReadPlanFile
} from '@oh-my-pi/pi-coding-agent/plan-mode/plan-files'
import {
  DEFAULT_COMPACTION_METHOD_ORDER as OMP_DEFAULT_COMPACTION_METHOD_ORDER,
  resolveCompactionMethodOrder as ompResolveCompactionMethodOrder
} from '@oh-my-pi/pi-coding-agent/session/compaction-methods'
import { getAgentDbPath as ompGetAgentDbPath } from '@oh-my-pi/pi-utils'

import type { PhiCompactionMethod } from './types'

type AssertAssignable<Actual extends Expected, Expected> = Actual

export interface PhiToolSchemaForTokenEstimate {
  name: string
  description: string
  parameters: unknown
  examples?: OmpTool['examples']
}

export interface PhiTokenizer {
  countTokens(text: string | string[]): number
}

export function estimateToolSchemaTokens(
  tools: readonly PhiToolSchemaForTokenEstimate[],
  tokenizer: PhiTokenizer
): number {
  // Count the provider-visible wire representation without loading the terminal UI.
  // A roster may contain extension getters or malformed schemas; one bad tool must
  // not hide the context usage of every other tool.
  const fragments: string[] = []
  for (const tool of tools) {
    if (typeof tool.name === 'string') fragments.push(tool.name)
    if (typeof tool.description === 'string') fragments.push(tool.description)
    try {
      const wireTool = tool as OmpTool
      const schema = JSON.stringify(toolWireSchema(wireTool) ?? {})
      if (typeof schema === 'string') fragments.push(schema)
      const examples = renderToolExamples(wireTool)
      if (examples) fragments.push(examples)
    } catch {
      // Cyclic or callable extension schemas are not serializable.
    }
  }
  return tokenizer.countTokens(fragments)
}

export type ConfiguredThinkingLevel =
  'inherit' | 'off' | 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export function parseConfiguredThinkingLevel(
  value: string | null | undefined
): ConfiguredThinkingLevel | undefined {
  if (value === undefined || value === null) return undefined
  const levels: readonly ConfiguredThinkingLevel[] = [
    'inherit',
    'off',
    'auto',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
  ]
  if (levels.includes(value as ConfiguredThinkingLevel)) return value as ConfiguredThinkingLevel
  if (value.length < 2 || 'auto'.startsWith(value)) return undefined
  const matches = levels.filter((level) => level !== 'auto' && level.startsWith(value))
  return matches.length === 1 ? matches[0] : undefined
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
type OmpTypeCompatibilityChecks = [
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
