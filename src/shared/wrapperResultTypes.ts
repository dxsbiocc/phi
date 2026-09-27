/** Renderer selects a saved run and a relative path, never SSH credentials or an absolute root. */
export interface WrapperResultDirectoryRequest {
  projectId: string
  hostProfileId: string
  runId: string
  scope: 'run' | 'output'
  path?: string
}

export interface WrapperResultReadRequest extends WrapperResultDirectoryRequest {
  requestId: string
}

export interface WrapperResultRangeRequest extends WrapperResultReadRequest {
  offset: number
  length: number
}

interface WrapperResultPreviewBase {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  bytes: number
  previewBytes: number
  truncated: boolean
}

export type WrapperResultPreview = WrapperResultPreviewBase &
  (
    | { kind: 'text'; mimeType: 'text/plain'; content: string }
    | {
        kind: 'image'
        mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
        dataUrl: string
      }
    | { kind: 'pdf'; mimeType: 'application/pdf'; dataUrl: string }
    | {
        kind: 'metadata'
        mimeType: string
        reason: 'large_file' | 'binary'
      }
  )

/** One bounded page; dataBase64 is ASCII and never contains an entire large file. */
export interface WrapperResultRange {
  path: string
  offset: number
  fileSize: number
  bytes: number
  identity: string
  dataBase64: string
}

export interface WrapperResultDownloadProgress {
  requestId: string
  phase: 'downloading' | 'verifying' | 'saving'
  bytesDownloaded: number
  totalBytes: number
}

export type WrapperResultDownloadResult =
  | { status: 'cancelled' }
  | {
      status: 'saved'
      path: string
      bytes: number
      sha256: string
      remoteDigestVerified: boolean
    }

/** Display/confirmation hint only; the main process still validates the POSIX path. */
export function declaredExternalOutputRoot(
  remoteRoot: string | undefined,
  outdir: unknown
): string | undefined {
  if (!remoteRoot || typeof outdir !== 'string' || !outdir.startsWith('/')) return undefined
  const root = remoteRoot.replace(/\/+$/, '') || '/'
  return root === '/' || outdir === root || outdir.startsWith(`${root}/`) ? undefined : outdir
}
