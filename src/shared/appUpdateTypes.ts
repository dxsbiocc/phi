export interface AppUpdateCheck {
  status: 'available' | 'up-to-date' | 'error'
  currentVersion: string
  latestVersion?: string
  publishedAt?: string
  /** The release page to download from; only a page of Phi's own releases. */
  releasesUrl: string
  checkedAt: string
  error?: string
}
