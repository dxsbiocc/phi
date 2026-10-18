import type { PhiHostRequestContext } from '../engine/types'
import type {
  InstalledPackage,
  InstallerOptions,
  LocalRegistry,
  PackageRequest,
  RegistryTrustTier
} from './installer-types'
import type { installPackages } from './lifecycle'
import type { PackageType } from './manifest'
import type { LoadedKnownRegistries } from './registries'

export interface CapabilityCandidate {
  candidateId: string
  type: PackageType
  id: string
  version: string
  title: string
  summary: string
  source: string
  trust: RegistryTrustTier
  installed: boolean
  enabled: boolean
  size: number
}

export interface CapabilitySearchResult {
  candidates: CapabilityCandidate[]
  errors: string[]
  officialAvailable: boolean
  canFindExternal: boolean
  notice?: string
}

export interface CapabilityApprovalPackage {
  type: PackageType
  id: string
  version: string
  title: string
  source: string
  trust: RegistryTrustTier
  size: number
  alreadyInstalled: boolean
}

export interface CapabilityApprovalRequest {
  runtimeSessionId: string
  candidateId: string
  root: Required<PackageRequest>
  action: 'install' | 'enable'
  reason: string
  source: string
  trust: RegistryTrustTier
  packages: CapabilityApprovalPackage[]
  totalSize: number
  environments: string[]
}

export type CapabilityInstallResult =
  | {
      ok: true
      installed: true
      root: Required<PackageRequest>
      packages: InstalledPackage[]
      usage: Array<{ type: PackageType; id: string; path: string }>
    }
  | { ok: false; installed: false; status: 'denied' | 'cancelled'; message: string }

export type CapabilityPrepare = (
  registry: LocalRegistry,
  request: PackageRequest,
  options: InstallerOptions,
  signal?: AbortSignal
) => Promise<LocalRegistry>

export interface RememberExternalCapabilitiesParams {
  runtimeSessionId: string
  query: string
  registries: LocalRegistry[]
  prepare?: CapabilityPrepare
}

export interface CapabilityService {
  search(params: unknown, context: PhiHostRequestContext): Promise<CapabilitySearchResult>
  install(params: unknown, context: PhiHostRequestContext): Promise<CapabilityInstallResult>
  rememberExternalCandidates(
    params: RememberExternalCapabilitiesParams,
    context: PhiHostRequestContext
  ): CapabilitySearchResult
}

export interface CapabilityServiceDependencies {
  agentDir: string
  appVersion: string
  loadRegistries: () => Promise<LoadedKnownRegistries>
  assertCurrent?: (context: PhiHostRequestContext) => void
  searchOfficial?: (
    query: string,
    type?: PackageType,
    signal?: AbortSignal
  ) => Promise<{
    matches: readonly { type: PackageType; id: string }[]
    available: boolean
    notice?: string
  }>
  confirm: (request: CapabilityApprovalRequest, context: PhiHostRequestContext) => Promise<boolean>
  installerOptions?: (context: PhiHostRequestContext) => Promise<InstallerOptions>
  afterInstall?: (
    result: Extract<CapabilityInstallResult, { ok: true }>,
    context: PhiHostRequestContext
  ) => Promise<void>
  /** Test seams also keep discovery separate from network materialization. */
  prepare?: CapabilityPrepare
  installPackages?: typeof installPackages
  listInstalled?: () => InstalledPackage[]
}
