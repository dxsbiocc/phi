export type TeamSourceState = 'healthy' | 'cached' | 'not-member' | 'withdrawn' | 'error'

export interface TeamSourceView {
  id: string
  teamId: string
  teamName: string
  teamKeyId: string
  location: { kind: 'directory'; path: string } | { kind: 'https'; url: string }
  addedAt: string
  status: {
    state: TeamSourceState
    lastSuccessfulRelease: number | null
    lastCheckedAt: string | null
    lastErrorCode: string | null
    withdrawnReleases: number[]
    credentialProviders: string[]
    credentialConflicts: string[]
    skippedProviders: string[]
  }
}
