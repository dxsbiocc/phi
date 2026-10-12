export interface GithubSourcePackagePreview {
  id: string
  version: string
  title: string
  summary: string
  publisher: string
  transport: 'http' | 'stdio'
}

export interface GithubSourceSkippedPackage {
  id?: string
  type: string
  reason: string
}

export interface GithubProjectHintNpm {
  name: string
  version: string
  repositoryMatches: true
  deprecated?: string
}

export interface GithubProjectHint {
  kind: 'node' | 'python' | 'unknown'
  summary: string
  name?: string
  version?: string
  entry?: string
  entryCommitted?: boolean
  needsBuild?: boolean
  nodeEngine?: string
  hasLifecycleScripts?: boolean
  hasLockfile?: boolean
  readmeUrl?: string
  npm?: GithubProjectHintNpm
  notices: string[]
}

export interface GithubLocalConnectorDraft {
  suggestedName: string
  command: 'x'
  args: string[]
  runtimeHint: 'bun'
}

export interface GithubSourcePreview {
  repo: string
  ref?: string
  sha: string
  packages: GithubSourcePackagePreview[]
  skipped: GithubSourceSkippedPackage[]
  warnings: string[]
  projectHint?: GithubProjectHint
  localDraft?: GithubLocalConnectorDraft
}

export interface GithubSourceSummary {
  id: string
  repo: string
  ref?: string
  sha: string
  registryPath: string
  addedAt: string
  updatedAt: string
}

export interface GithubSourceDiff {
  added: Array<{ id: string; version: string }>
  removed: Array<{ id: string; version: string }>
  changed: Array<{ id: string; fromVersion: string; toVersion: string }>
}

export type GithubSourceUpdateCheck =
  | { changed: false; source: GithubSourceSummary }
  | (GithubSourcePreview & {
      changed: true
      source: GithubSourceSummary
      diff: GithubSourceDiff
    })
