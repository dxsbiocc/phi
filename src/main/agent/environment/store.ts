import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import {
  ENVIRONMENT_TOOL_IDS,
  ENVIRONMENT_TOOL_LABELS,
  type EnvironmentGetResult,
  type EnvironmentSnapshot,
  type EnvironmentToolId,
  type EnvironmentToolState
} from '../../../shared/environmentTypes'
import { getPhiAgentDir } from '../runtime-paths'
import {
  detectEnvironmentTools,
  probeCustomToolPath,
  type DetectEnvironmentOptions
} from './detect'

const ENVIRONMENT_FILE = 'environment.json'

type PersistedCustomPaths = Partial<Record<EnvironmentToolId, string>>

type PersistedEnvironmentFile = {
  firstScanCompleted?: boolean
  summaryDismissed?: boolean
  scannedAt?: string
  customPaths?: PersistedCustomPaths
  /** Last scan cache — rewritten on each detect. */
  tools?: EnvironmentToolState[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getEnvironmentPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, ENVIRONMENT_FILE)
}

function emptyTools(): EnvironmentToolState[] {
  return ENVIRONMENT_TOOL_IDS.map((id) => ({
    id,
    label: ENVIRONMENT_TOOL_LABELS[id],
    status: 'missing' as const,
    source: 'none' as const
  }))
}

function readPersisted(agentDir: string): PersistedEnvironmentFile {
  const path = getEnvironmentPath(agentDir)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return isRecord(parsed) ? (parsed as PersistedEnvironmentFile) : {}
  } catch {
    return {}
  }
}

function writePersisted(agentDir: string, data: PersistedEnvironmentFile): void {
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(getEnvironmentPath(agentDir), `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
}

function normalizeCustomPaths(raw: unknown): PersistedCustomPaths {
  if (!isRecord(raw)) return {}
  const out: PersistedCustomPaths = {}
  for (const id of ENVIRONMENT_TOOL_IDS) {
    const value = raw[id]
    if (typeof value === 'string' && value.trim() && isAbsolute(value.trim())) {
      out[id] = resolve(value.trim())
    }
  }
  return out
}

/** Apply user custom paths on top of a fresh detection result. */
export function mergeDetectedWithCustoms(
  detected: EnvironmentToolState[],
  customPaths: PersistedCustomPaths,
  options: DetectEnvironmentOptions = {}
): EnvironmentToolState[] {
  return detected.map((tool) => {
    const custom = customPaths[tool.id]
    if (!custom) return tool
    const probed = probeCustomToolPath(tool.id, custom, options)
    return {
      ...probed,
      // Keep last auto-detect path for UI "use detected" affordance.
      ...(tool.detectedPath ? { detectedPath: tool.detectedPath } : {}),
      ...(tool.detectedVersion && !probed.detectedVersion
        ? { detectedVersion: tool.detectedVersion }
        : {})
    }
  })
}

function toSnapshot(
  tools: EnvironmentToolState[],
  meta: {
    scannedAt: string
    firstScanCompleted: boolean
    summaryDismissed: boolean
  }
): EnvironmentSnapshot {
  return {
    scannedAt: meta.scannedAt,
    firstScanCompleted: meta.firstScanCompleted,
    summaryDismissed: meta.summaryDismissed,
    tools
  }
}

function persistSnapshot(
  agentDir: string,
  snapshot: EnvironmentSnapshot,
  customPaths: PersistedCustomPaths
): void {
  writePersisted(agentDir, {
    firstScanCompleted: snapshot.firstScanCompleted,
    summaryDismissed: snapshot.summaryDismissed,
    scannedAt: snapshot.scannedAt,
    customPaths,
    tools: snapshot.tools
  })
}

export function readEnvironmentSnapshot(agentDir = getPhiAgentDir()): EnvironmentSnapshot {
  const persisted = readPersisted(agentDir)
  if (Array.isArray(persisted.tools) && persisted.tools.length > 0) {
    return toSnapshot(persisted.tools, {
      scannedAt:
        typeof persisted.scannedAt === 'string' ? persisted.scannedAt : new Date(0).toISOString(),
      firstScanCompleted: persisted.firstScanCompleted === true,
      summaryDismissed: persisted.summaryDismissed === true
    })
  }
  return toSnapshot(emptyTools(), {
    scannedAt: new Date(0).toISOString(),
    firstScanCompleted: false,
    summaryDismissed: false
  })
}

export function scanAndPersistEnvironment(
  agentDir = getPhiAgentDir(),
  options: DetectEnvironmentOptions = {}
): EnvironmentSnapshot {
  const persisted = readPersisted(agentDir)
  const customPaths = normalizeCustomPaths(persisted.customPaths)
  const detected = detectEnvironmentTools(options)
  const tools = mergeDetectedWithCustoms(detected, customPaths, options)
  const scannedAt = options.now?.() ?? new Date().toISOString()
  const snapshot = toSnapshot(tools, {
    scannedAt,
    firstScanCompleted: true,
    // Re-scan keeps dismissal unless this was the very first scan.
    summaryDismissed:
      persisted.firstScanCompleted === true ? persisted.summaryDismissed === true : false
  })
  persistSnapshot(agentDir, snapshot, customPaths)
  return snapshot
}

export function getEnvironment(agentDir = getPhiAgentDir()): EnvironmentGetResult {
  const persisted = readPersisted(agentDir)
  if (persisted.firstScanCompleted !== true) {
    const snapshot = scanAndPersistEnvironment(agentDir)
    return {
      snapshot,
      showSummary: !snapshot.summaryDismissed
    }
  }
  const snapshot = readEnvironmentSnapshot(agentDir)
  return {
    snapshot,
    showSummary: !snapshot.summaryDismissed
  }
}

export function redetectEnvironment(agentDir = getPhiAgentDir()): EnvironmentSnapshot {
  return scanAndPersistEnvironment(agentDir)
}

export function dismissEnvironmentSummary(agentDir = getPhiAgentDir()): EnvironmentSnapshot {
  const persisted = readPersisted(agentDir)
  const snapshot = readEnvironmentSnapshot(agentDir)
  const next = { ...snapshot, summaryDismissed: true }
  persistSnapshot(agentDir, next, normalizeCustomPaths(persisted.customPaths))
  return next
}

export function setEnvironmentToolPath(
  toolId: EnvironmentToolId,
  path: string | null,
  agentDir = getPhiAgentDir(),
  options: DetectEnvironmentOptions = {}
): EnvironmentSnapshot {
  if (!ENVIRONMENT_TOOL_IDS.includes(toolId)) {
    throw new Error(`未知工具: ${toolId}`)
  }

  const persisted = readPersisted(agentDir)
  const customPaths = normalizeCustomPaths(persisted.customPaths)

  if (path === null || path.trim() === '') {
    delete customPaths[toolId]
  } else {
    const trimmed = path.trim()
    if (!isAbsolute(trimmed)) {
      throw new Error('工具路径必须是绝对路径')
    }
    const probed = probeCustomToolPath(toolId, resolve(trimmed), options)
    if (probed.status === 'invalid') {
      throw new Error(probed.messages?.[0] ?? '无法验证该路径')
    }
    customPaths[toolId] = resolve(trimmed)
  }

  const detected = detectEnvironmentTools(options)
  const tools = mergeDetectedWithCustoms(detected, customPaths, options)
  const scannedAt = options.now?.() ?? new Date().toISOString()
  const snapshot = toSnapshot(tools, {
    scannedAt,
    firstScanCompleted: true,
    summaryDismissed: persisted.summaryDismissed === true
  })
  persistSnapshot(agentDir, snapshot, customPaths)
  return snapshot
}

export function getActiveToolPath(
  toolId: EnvironmentToolId,
  agentDir = getPhiAgentDir()
): string | undefined {
  const tool = readEnvironmentSnapshot(agentDir).tools.find((item) => item.id === toolId)
  if (tool?.status === 'ready' && tool.activePath) return tool.activePath
  return undefined
}

/**
 * The path the user set explicitly for a tool (`customPaths`), whether or not it is
 * currently valid. Unlike {@link getActiveToolPath} this ignores auto-detected paths:
 * wrappers use a host nextflow only when the user chose one (runtime foundation §5.2).
 */
export function getCustomToolPath(
  toolId: EnvironmentToolId,
  agentDir = getPhiAgentDir()
): string | undefined {
  return normalizeCustomPaths(readPersisted(agentDir).customPaths)[toolId]
}
