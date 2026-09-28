export const MAX_WORKSPACE_CHANGE_FILES = 50
export const MAX_WORKSPACE_DIFF_BYTES = 128 * 1024

export type WorkspaceDiffReference = {
  sessionId: string
  id: string
  bytes: number
}

export type WorkspaceFileChange = {
  path: string
  displayPath: string
  status: 'added' | 'modified' | 'deleted'
  added: number | null
  deleted: number | null
  diff?: WorkspaceDiffReference
}

export type WorkspaceChangeSummary = {
  files: WorkspaceFileChange[]
  totalChanged: number
  truncated: boolean
}
