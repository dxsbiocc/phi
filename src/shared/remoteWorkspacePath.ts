export interface RemoteWorkspaceFileRequest {
  sessionId: string
  projectId: string
  path: string
}

function validHost(hostAlias: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(hostAlias)
}

function validAbsoluteSegments(path: string): string[] | null {
  if (!path.startsWith('/') || path.includes('\0')) return null
  const segments = path.split('/').slice(1)
  if (segments.some((part) => part === '.' || part === '..')) return null
  return segments
}

/** Display identity only; the main process still chooses the SSH host from the project ID. */
export function remoteWorkspaceUri(hostAlias: string, absolutePath: string): string {
  if (!validHost(hostAlias) || !validAbsoluteSegments(absolutePath)) {
    throw new Error('远程工作区路径无效')
  }
  return `ssh://${hostAlias}${absolutePath.split('/').map(encodeURIComponent).join('/')}`
}

/** Accept only the selected host and a path inside its canonical project root. */
export function remotePathWithinProjectUri(
  uri: string,
  hostAlias: string,
  canonicalRoot: string
): string | null {
  if (!validHost(hostAlias) || !validAbsoluteSegments(canonicalRoot)) return null
  const prefix = `ssh://${hostAlias}`
  if (!uri.startsWith(`${prefix}/`) || /[?#]/.test(uri)) return null
  const encodedSegments = uri.slice(prefix.length + 1).split('/')
  const segments: string[] = []
  try {
    for (const encoded of encodedSegments) {
      const segment = decodeURIComponent(encoded)
      if (segment.includes('/') || segment.includes('\0') || segment === '.' || segment === '..') {
        return null
      }
      segments.push(segment)
    }
  } catch {
    return null
  }
  const path = `/${segments.join('/')}`
  const root = canonicalRoot === '/' ? '/' : canonicalRoot.replace(/\/+$/, '')
  return root === '/' || path === root || path.startsWith(`${root}/`) ? path : null
}

export function remotePathInsideRoot(path: string, canonicalRoot: string): boolean {
  if (!validAbsoluteSegments(path) || !validAbsoluteSegments(canonicalRoot)) return false
  const root = canonicalRoot === '/' ? '/' : canonicalRoot.replace(/\/+$/, '')
  return root === '/' || path === root || path.startsWith(`${root}/`)
}

export type RemoteUriToken =
  { kind: 'text'; text: string } | { kind: 'path'; text: string; path: string }

/** Split only URIs on the selected host and project; foreign SSH URLs remain plain text. */
export function tokenizeRemoteWorkspaceUris(
  text: string,
  hostAlias: string,
  canonicalRoot: string
): RemoteUriToken[] {
  const tokens: RemoteUriToken[] = []
  const pattern = /ssh:\/\/[A-Za-z0-9][A-Za-z0-9._@-]*\/[^\s<>"'`()[\]]+/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const raw = match[0]
    const suffix = /[.,;:!?，。；：！？]+$/.exec(raw)?.[0] ?? ''
    const uri = suffix ? raw.slice(0, -suffix.length) : raw
    const path = remotePathWithinProjectUri(uri, hostAlias, canonicalRoot)
    if (!path) continue
    const start = match.index ?? 0
    if (start > cursor) tokens.push({ kind: 'text', text: text.slice(cursor, start) })
    tokens.push({ kind: 'path', text: uri, path })
    if (suffix) tokens.push({ kind: 'text', text: suffix })
    cursor = start + raw.length
  }
  if (cursor < text.length) tokens.push({ kind: 'text', text: text.slice(cursor) })
  return tokens.length > 0 ? tokens : [{ kind: 'text', text }]
}
