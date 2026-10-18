import { connectorCopy } from './connectorCopy'
export function githubImportUrlError(input: string): string | null {
  const raw = input.trim()
  if (!raw) return connectorCopy.enterGithubUrl
  if (/%[0-9a-f]{2}/i.test(raw)) return connectorCopy.githubEncodedPath
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return connectorCopy.githubInvalidUrl
  }
  const authority = /^https:\/\/([^/]+)(?:\/|$)/i.exec(raw)?.[1]
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    authority?.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return connectorCopy.githubUrlConstraints
  }
  const parts = url.pathname.split('/').slice(1)
  const trailingSlash = parts.at(-1) === ''
  if (trailingSlash) parts.pop()
  if (parts.length < 2 || parts.some((part) => !part)) return connectorCopy.githubInvalidUrl
  const owner = parts[0]!
  const rawName = parts[1]!
  const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(name) ||
    name === '.' ||
    name === '..'
  ) {
    return connectorCopy.githubInvalidRepo
  }
  if (parts.length > 2) {
    if (trailingSlash || parts[2] !== 'tree' || parts.length < 4) {
      return connectorCopy.githubInvalidPath
    }
    const ref = parts.slice(3).join('/')
    if (
      !/^[A-Za-z0-9._/-]{1,200}$/.test(ref) ||
      ref.includes('..') ||
      ref.startsWith('-') ||
      ref.startsWith('/') ||
      ref.endsWith('/')
    ) {
      return connectorCopy.githubInvalidRef
    }
  }
  return null
}
