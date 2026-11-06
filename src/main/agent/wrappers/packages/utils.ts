import { createHash } from 'node:crypto'
import { isAbsolute, sep } from 'node:path'

export function packageId(
  kind: 'module' | 'subworkflow' | 'workflow' | 'support',
  provider: string,
  name: string
): string {
  const id = `${kind}-${provider}-${name}`
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) {
    throw new Error(`invalid generated wrapper package id '${id}'`)
  }
  return id
}

export function normalizeTreePath(path: string): string {
  const normalized = path.split(sep).join('/')
  assertSafeArchivePath(normalized)
  return normalized
}

export function assertSafeArchivePath(path: string): void {
  const parts = path.split('/')
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe package path '${path}'`)
  }
}

export function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

export function isTextLike(path: string): boolean {
  return /(?:^|\/)(?:[^/]+\.(?:nf|config|ya?ml|json|md|txt|groovy|py|r|sh)|Dockerfile)$/i.test(path)
}

export function isRunLeftover(path: string): boolean {
  const parts = path.split('/')
  const name = parts.at(-1) ?? ''
  return (
    parts.includes('.nextflow') ||
    parts.includes('work') ||
    parts.includes('results') ||
    parts.includes('__pycache__') ||
    name === '.DS_Store' ||
    name.startsWith('.nextflow.log')
  )
}

export function compareRegistryEntries<T extends { id: string; version: string }>(
  left: T,
  right: T
): number {
  return compareText(left.id, right.id) || compareText(left.version, right.version)
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
