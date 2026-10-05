import { validOfficeSheetName } from './office-read-contract'
import type { OfficeAddSheetResult } from './office-write-contract'

export function decodeAddSheetResult(value: Record<string, unknown>): OfficeAddSheetResult {
  if (!validAddSheetResult(value)) throw new Error('invalid add sheet result')
  const sheetNames = value.sheetNames as string[]
  return {
    applied: true,
    saved: value.saved as boolean,
    revision: value.revision as number,
    sheet: value.sheet as string,
    path: value.path as string,
    sheetCount: sheetNames.length,
    sheetNames,
    previewConfirmed: value.previewConfirmed as boolean,
    ...(value.warnings ? { warnings: value.warnings as string[] } : {}),
    ...(value.deduplicated === true ? { deduplicated: true } : {}),
    ...(value.reconciled === true ? { reconciled: true } : {})
  }
}

export function validOfficeSheetNames(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 20 &&
    value.every((name) => typeof name === 'string' && validOfficeSheetName(name)) &&
    new Set(value.map((name) => name.toUpperCase())).size === value.length
  )
}

function validAddSheetResult(value: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(value, resultKeys) || !validOfficeSheetNames(value.sheetNames)) return false
  return (
    value.applied === true &&
    typeof value.saved === 'boolean' &&
    validRevision(value.revision) &&
    typeof value.sheet === 'string' &&
    value.path === `/${value.sheet}` &&
    value.sheetCount === value.sheetNames.length &&
    value.sheetNames.filter((name) => name === value.sheet).length === 1 &&
    typeof value.previewConfirmed === 'boolean' &&
    (value.warnings === undefined || validWarnings(value.warnings)) &&
    (value.deduplicated === undefined || value.deduplicated === true) &&
    (value.reconciled === undefined || value.reconciled === true)
  )
}

const resultKeys = [
  'applied',
  'saved',
  'revision',
  'sheet',
  'path',
  'sheetCount',
  'sheetNames',
  'previewConfirmed',
  'warnings',
  'deduplicated',
  'reconciled'
] as const

function validWarnings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((warning) => typeof warning === 'string')
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}
