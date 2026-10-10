import { parseEnvironmentRef } from '../envs'

const MATCH_SPEC = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\s*[=<>!~]=?[^\s,;]+(,[<>=!~]=?[^\s,;]+)*)?$/

export interface ValidRemoteEnvironmentRequest {
  requestId?: string
  runtimeSessionId: string
  packages: string[]
  reason: string
  environment: string
  pluginId?: string
}

export function validRemoteEnvironmentRequest(params: unknown): ValidRemoteEnvironmentRequest {
  const record = requireRecord(params)
  const packages = validPackages(record.packages)
  const reason = requireText(record, 'reason').trim()
  if (reason.length > 500) throw new Error('reason must be 1 to 500 characters')
  const environment = requireText(record, 'environment')
  if (parseEnvironmentRef(environment).kind === 'path') {
    throw new Error('environment must be phi:<name>@<major>, plugin:<name>, or project:<name>')
  }
  const requestId = optionalText(record.requestId)
  const pluginId = optionalText(record.pluginId)
  return {
    runtimeSessionId: requireText(record, 'runtimeSessionId'),
    packages,
    reason,
    environment,
    ...(requestId ? { requestId } : {}),
    ...(pluginId ? { pluginId } : {})
  }
}

function validPackages(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error('packages must contain 1 to 20 conda match specs')
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.includes('::') || !MATCH_SPEC.test(item)) {
      throw new Error(`invalid conda match spec '${String(item)}'`)
    }
    if ((item.split(/[\s=<>!~]/, 1)[0] ?? '').toLowerCase() === 'pip') {
      throw new Error('pip packages are not allowed')
    }
    return item
  })
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected an object')
  }
  return value as Record<string, unknown>
}

function requireText(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`)
  return value
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
