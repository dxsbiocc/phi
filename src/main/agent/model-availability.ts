import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ModelAvailabilityChange,
  ModelAvailabilitySettings,
  ModelRef
} from '../../shared/modelAvailabilityTypes'
import { isRecord } from '../../shared/guards'
import { getPhiAgentDir } from './runtime-paths'

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
}

export function normalizeModelAvailability(value: unknown): ModelAvailabilitySettings {
  const raw = isRecord(value) ? value : {}
  const disabledProviders = Array.isArray(raw.disabledProviders)
    ? [...new Set(raw.disabledProviders.filter(validId))]
    : []
  const models = new Map<string, ModelRef>()
  for (const item of Array.isArray(raw.disabledModels) ? raw.disabledModels : []) {
    if (isRecord(item) && validId(item.providerId) && validId(item.modelId)) {
      models.set(JSON.stringify([item.providerId, item.modelId]), {
        providerId: item.providerId,
        modelId: item.modelId
      })
    }
  }
  return { disabledProviders, disabledModels: [...models.values()] }
}

export function getModelAvailabilityPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'model-availability.json')
}

function parseStoredAvailability(value: unknown): ModelAvailabilitySettings {
  if (
    !isRecord(value) ||
    !Array.isArray(value.disabledProviders) ||
    !value.disabledProviders.every(validId) ||
    !Array.isArray(value.disabledModels) ||
    !value.disabledModels.every(
      (model) => isRecord(model) && validId(model.providerId) && validId(model.modelId)
    )
  )
    throw new Error('Invalid model availability settings')
  return normalizeModelAvailability(value)
}

export function readModelAvailability(agentDir = getPhiAgentDir()): ModelAvailabilitySettings {
  const path = getModelAvailabilityPath(agentDir)
  if (existsSync(path)) {
    try {
      return parseStoredAvailability(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      // A damaged policy must be visible; silently treating it as enabled would restore blocked models.
      throw new Error('Model availability settings could not be read')
    }
  }
  // Narrow, read-only compatibility for earlier Phi saves and OMP's legacy-settings rename.
  // An existing dedicated file always wins, including an explicit empty policy.
  for (const file of ['settings.json', 'settings.json.bak']) {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(agentDir, file), 'utf8'))
      if (isRecord(raw) && Object.hasOwn(raw, 'modelAvailability'))
        return normalizeModelAvailability(raw.modelAvailability)
    } catch {
      /* Unrelated legacy preference files are not the policy store. */
    }
  }
  return { disabledProviders: [], disabledModels: [] }
}

function writeAvailability(settings: ModelAvailabilitySettings, agentDir: string): void {
  mkdirSync(agentDir, { recursive: true })
  const path = getModelAvailabilityPath(agentDir)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function isModelEnabled(
  settings: ModelAvailabilitySettings,
  providerId: string,
  modelId?: string
): boolean {
  return (
    !settings.disabledProviders.includes(providerId) &&
    (modelId === undefined ||
      !settings.disabledModels.some(
        (model) => model.providerId === providerId && model.modelId === modelId
      ))
  )
}

export function parseModelAvailabilityChange(value: unknown): ModelAvailabilityChange {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['providerId', 'modelId', 'enabled'].includes(key)) ||
    !validId(value.providerId) ||
    (Object.hasOwn(value, 'modelId') && !validId(value.modelId)) ||
    typeof value.enabled !== 'boolean'
  )
    throw new Error('Invalid model availability change')
  return {
    providerId: value.providerId,
    ...(value.modelId !== undefined ? { modelId: value.modelId as string } : {}),
    enabled: value.enabled
  }
}

/** Catalog validation happens first; read/merge/write here is one synchronous main-process turn. */
export function writeModelAvailabilityChange(
  change: ModelAvailabilityChange,
  agentDir = getPhiAgentDir()
): ModelAvailabilitySettings {
  const parsed = parseModelAvailabilityChange(change)
  const current = readModelAvailability(agentDir)
  if (parsed.modelId === undefined) {
    current.disabledProviders = current.disabledProviders.filter((id) => id !== parsed.providerId)
    if (!parsed.enabled) current.disabledProviders.push(parsed.providerId)
  } else {
    current.disabledModels = current.disabledModels.filter(
      (model) => model.providerId !== parsed.providerId || model.modelId !== parsed.modelId
    )
    if (!parsed.enabled)
      current.disabledModels.push({ providerId: parsed.providerId, modelId: parsed.modelId })
  }
  writeAvailability(current, agentDir)
  return current
}
