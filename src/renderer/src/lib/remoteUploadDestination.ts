import { remotePathWithinProjectUri } from '../../../shared/remoteWorkspacePath'

const selectedDirectories = new Map<string, string>()

export function rememberRemoteUploadDestination(projectId: string, uri: string): void {
  if (!projectId || !uri.startsWith('ssh://')) return
  selectedDirectories.set(projectId, uri)
}

export function selectedRemoteUploadDestination(projectId: string): string | null {
  return selectedDirectories.get(projectId) ?? null
}

export function remoteUploadDestinationDirectory(
  uri: string,
  hostAlias: string,
  canonicalRoot: string
): string | null {
  const path = remotePathWithinProjectUri(uri, hostAlias, canonicalRoot)
  if (path === null) return null
  if (path === canonicalRoot) return ''
  const prefix = canonicalRoot.endsWith('/') ? canonicalRoot : `${canonicalRoot}/`
  if (!path.startsWith(prefix)) return null
  const relative = path.slice(prefix.length)
  if (!relative || relative === '..' || relative.startsWith('../') || relative.includes('\0')) {
    return null
  }
  return relative
}

/** Test and project-removal cleanup; selected directories are renderer-session state only. */
export function clearRemoteUploadDestinations(): void {
  selectedDirectories.clear()
}
