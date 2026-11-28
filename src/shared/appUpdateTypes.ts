export type AppUpdateInstallMode = 'auto-replace' | 'open-installer' | 'manual'

export interface AppUpdateAsset {
  name: string
  downloadUrl: string
  size: number
  checksumUrl?: string
  installMode: AppUpdateInstallMode
}

export interface AppUpdateCheck {
  status: 'available' | 'up-to-date' | 'error'
  currentVersion: string
  latestVersion?: string
  releaseTitle?: string
  releaseNotes?: string
  publishedAt?: string
  /** The release page to download from; only a page of Phi's own releases. */
  releasesUrl: string
  asset?: AppUpdateAsset
  checkedAt: string
  error?: string
}

export type AppUpdateDownloadStage =
  'idle' | 'downloading' | 'verifying' | 'downloaded' | 'installing' | 'error'

export interface AppUpdateDownloadState {
  stage: AppUpdateDownloadStage
  version?: string
  assetName?: string
  installMode?: AppUpdateInstallMode
  downloadedBytes: number
  totalBytes: number
  percent: number | null
  downloadedPath?: string
  sha256?: string
  error?: string
}
