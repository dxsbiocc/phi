import type { WrapperRunResources } from '../../../../shared/wrapperTypes'

export type { WrapperRunResources } from '../../../../shared/wrapperTypes'

/**
 * Per-run compute resources for a wrapper. Wrappers ship with defaults sized
 * for their tiny test data (STAR: 4 CPUs, 6 GB), which real genomes blow past,
 * so a run can ask for more. The values end up in a Nextflow config file, so
 * they are validated into a closed set of shapes rather than passed through.
 */

export type ParsedResources =
  { ok: true; resources?: WrapperRunResources } | { ok: false; error: string }

const MAX_CPUS = 1024
const KNOWN_KEYS = new Set(['cpus', 'memory', 'time'])

const MEMORY_PATTERN = /^(\d+(?:\.\d+)?)\s*(k|kb|m|mb|g|gb|t|tb)$/i
const MEMORY_UNITS: Record<string, string> = { k: 'KB', m: 'MB', g: 'GB', t: 'TB' }

const DURATION_TOKEN =
  /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi
const DURATION_UNITS: Record<string, string> = { d: 'd', h: 'h', m: 'm', s: 's' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMemory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = MEMORY_PATTERN.exec(value.trim())
  if (!match) return undefined
  return `${Number(match[1])} ${MEMORY_UNITS[match[2][0].toLowerCase()]}`
}

function parseDuration(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parts: string[] = []
  const rest = value.replace(DURATION_TOKEN, (_match, amount: string, unit: string) => {
    parts.push(`${Number(amount)}${DURATION_UNITS[unit[0].toLowerCase()]}`)
    return ''
  })
  return rest.trim() === '' && parts.length > 0 ? parts.join(' ') : undefined
}

export function parseWrapperRunResources(value: unknown): ParsedResources {
  if (value === undefined || value === null) return { ok: true }
  if (!isRecord(value)) {
    return {
      ok: false,
      error: 'resources must be an object like {"cpus": 8, "memory": "40 GB", "time": "4h"}'
    }
  }
  const unknown = Object.keys(value).filter((key) => !KNOWN_KEYS.has(key))
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown resources: ${unknown.join(', ')}. Use cpus, memory and time.`
    }
  }

  const resources: WrapperRunResources = {}
  if (value.cpus !== undefined) {
    const cpus = value.cpus
    if (typeof cpus !== 'number' || !Number.isInteger(cpus) || cpus < 1 || cpus > MAX_CPUS) {
      return { ok: false, error: `resources.cpus must be a whole number from 1 to ${MAX_CPUS}.` }
    }
    resources.cpus = cpus
  }
  if (value.memory !== undefined) {
    const memory = parseMemory(value.memory)
    if (!memory) {
      return {
        ok: false,
        error: 'resources.memory must be an amount with a unit, such as "40 GB" or "512 MB".'
      }
    }
    resources.memory = memory
  }
  if (value.time !== undefined) {
    const time = parseDuration(value.time)
    if (!time) {
      return {
        ok: false,
        error: 'resources.time must be a duration such as "4h", "30m" or "1d 6h".'
      }
    }
    resources.time = time
  }
  return Object.keys(resources).length > 0 ? { ok: true, resources } : { ok: true }
}

/**
 * The Nextflow config lines for a run's resources, or '' when there are none.
 * `withName: '.*'` rather than plain `process.cpus`: a wrapper's own
 * `withName` selector would otherwise still win over a generic setting.
 */
export function buildResourceConfig(resources: WrapperRunResources | undefined): string {
  if (!resources) return ''
  const lines = [
    resources.cpus !== undefined ? `        cpus = ${resources.cpus}` : '',
    resources.memory !== undefined ? `        memory = '${resources.memory}'` : '',
    resources.time !== undefined ? `        time = '${resources.time}'` : ''
  ].filter(Boolean)
  if (lines.length === 0) return ''
  return [
    '// Resources requested for this run; they override every process own setting.',
    'process {',
    "    withName: '.*' {",
    ...lines,
    '    }',
    '}',
    ''
  ].join('\n')
}
