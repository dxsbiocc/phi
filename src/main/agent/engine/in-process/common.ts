import { ModelRegistry } from '@oh-my-pi/pi-coding-agent'
import { AuthStorage } from '@oh-my-pi/pi-ai'
import { PhiAuth } from '../types'

export type UnknownRecord = Record<string, unknown>

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ProjectResourceName = 'extensions' | 'prompts' | 'skills' | 'themes'

export type RuntimeContext = {
  agentDir: string
  auth: PhiAuth
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
}

export type RuntimeModel = NonNullable<ReturnType<ModelRegistry['find']>>

export type WorkerPromptOptions = {
  images?: Array<{ type: 'image'; data: string; mimeType: string }>
  expandPromptTemplates?: boolean
  synthetic?: boolean
  userInitiated?: boolean
  skipCompactionCheck?: boolean
}

export type IncomingRequest = {
  id: string
  method: string
  params?: unknown
}

export type HostResponse =
  | {
      type: 'hostResponse'
      id: string
      ok: true
      result?: unknown
    }
  | {
      type: 'hostResponse'
      id: string
      ok: false
      error: string
      stack?: string
    }

export type HostRequestContext = {
  originSessionId?: string
  agentRunId?: string
  toolCallId?: string
}

export type RuntimeModelSummary = {
  provider: string
  id: string
  name: string
  reasoning: boolean
  supportsImages: boolean
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length > 0 ? strings : undefined
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function toJsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString()
      if (typeof item === 'function') return undefined
      return item
    })
  )
}
