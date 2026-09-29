export type ContextUsageCategoryId =
  | 'systemPrompt'
  | 'toolDefinitions'
  | 'systemTools'
  | 'mcpTools'
  | 'systemContext'
  | 'skills'
  | 'conversation'

export interface ContextUsageCategory {
  id: ContextUsageCategoryId
  tokens: number
}

export interface ContextUsageSnapshot {
  tokens: number
  contextWindow: number
  percent: number
  categories?: ContextUsageCategory[]
  /** Full schema estimate for enabled MCP tools not directly sent to the model. */
  deferredMcpTokens?: number
}

export interface ContextCompactionDetails {
  action: string
  reason?: string
  tokensBefore?: number
  tokensAfter?: number
  summary?: string
  shortSummary?: string
}

export interface CurrentContextUsage {
  sessionPath: string | null
  phiSessionId: string | null
  sessionGeneration: number
  usage: ContextUsageSnapshot | null
}

export type ManualCompactionTarget = Pick<
  CurrentContextUsage,
  'sessionPath' | 'phiSessionId' | 'sessionGeneration'
>

export const AUTO_COMPACTION_THRESHOLD_PRESETS = [70, 80, 90] as const
export type AutoCompactionThresholdPreset = (typeof AUTO_COMPACTION_THRESHOLD_PRESETS)[number]

export interface AutoCompactionOverrides {
  enabled?: boolean
  thresholdPercent?: AutoCompactionThresholdPreset
}

export interface AutoCompactionSettingsPatch {
  enabled?: boolean | null
  thresholdPercent?: AutoCompactionThresholdPreset | null
}

export interface AutoCompactionDefaults {
  enabled: boolean
  thresholdPercent: number
  thresholdTokens: number
}

export interface CurrentAutoCompactionSettings extends ManualCompactionTarget {
  enabled: boolean
  thresholdPercent: number
  defaults: AutoCompactionDefaults
  overrides: AutoCompactionOverrides
}

export interface AutoCompactionApi {
  getAutoCompactionSettings(target: ManualCompactionTarget): Promise<CurrentAutoCompactionSettings>
  setAutoCompactionSettings(
    target: ManualCompactionTarget,
    patch: AutoCompactionSettingsPatch
  ): Promise<CurrentAutoCompactionSettings>
}

export interface ContextCompactionSummary {
  summary: string
  shortSummary?: string
  tokensBefore: number
  tokensAfter?: number
}

export interface ManualCompactionOutcome {
  sessionPath: string
  phiSessionId: string
  tokensBefore: number
  tokensAfter?: number
  shortSummary?: string
}
