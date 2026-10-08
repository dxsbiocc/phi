/** Read-only directory selection before a remote project has been registered. */
export interface RemoteDirectoryListRequest {
  hostProfileId: string
  path: string
}

export interface RemoteDirectoryListing {
  hostProfileId: string
  /** Physical absolute directory returned by the selected SSH host. */
  path: string
  directories: Array<{ name: string; path: string }>
  truncated: boolean
}
