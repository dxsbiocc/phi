import { posix } from 'node:path'
import { rpcIdentifier } from './control-frame'
import type { DesktopWebSearchMetadata, DesktopWebSearchModel } from './desktop-websearch-types'

export function webSearchRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function webSearchPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value.length < 4096 &&
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    posix.normalize(value) === value
  )
}
export function webSearchModel(value: unknown): value is DesktopWebSearchModel {
  return (
    webSearchRecord(value) &&
    Object.keys(value).length === 2 &&
    rpcIdentifier(value.provider) &&
    rpcIdentifier(value.id)
  )
}
/** Only the public tool input schema; CLI-only model overrides are deliberately excluded. */
export function webSearchParams(value: unknown): value is Record<string, unknown> {
  if (
    !webSearchRecord(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !('value' in descriptor) || !descriptor.enumerable
    ) ||
    typeof value.query !== 'string'
  )
    return false
  const allowed = ['query', 'recency', 'limit', 'max_tokens', 'temperature', 'num_search_results']
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false
  if (
    value.recency !== undefined &&
    !['day', 'week', 'month', 'year'].includes(String(value.recency))
  )
    return false
  return ['limit', 'max_tokens', 'temperature', 'num_search_results'].every(
    (key) =>
      value[key] === undefined || (typeof value[key] === 'number' && Number.isFinite(value[key]))
  )
}
export function webSearchMetadata(value: unknown): value is DesktopWebSearchMetadata {
  return (
    webSearchRecord(value) &&
    Object.keys(value).length === 4 &&
    value.name === 'web_search' &&
    typeof value.label === 'string' &&
    typeof value.description === 'string' &&
    webSearchRecord(value.parameters)
  )
}
