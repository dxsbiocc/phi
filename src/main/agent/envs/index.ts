export { environmentSpecSchema, envMetadataSchema } from './schemas'

export {
  ENVIRONMENT_CONTRACT_VERSION,
  ENV_STATUS_TRANSITIONS,
  PHI_PLATFORMS,
  canTransition,
  computeEnvId,
  condaSpecOf,
  condaSubdir,
  currentPlatform,
  findPlatform,
  lockSha256,
  normalizeLockText,
  parseEnvironmentRef,
  parseEnvironmentSpec,
  parseExplicitLock
} from './contract'

export type {
  CondaDependency,
  CondaEnvironmentSpec,
  EnvIdInput,
  EnvKind,
  EnvMetadata,
  EnvScope,
  EnvStatus,
  EnvironmentRef,
  EnvironmentSpec,
  EnvironmentSpecParseResult,
  HostRequirement,
  LockEntry,
  LockParseResult,
  PhiPlatform,
  SourcePackage
} from './contract'

export {
  ensureMambarc,
  ensureRuntimeLayout,
  getRuntimeRoot,
  micromambaEnvironment,
  renderMambarc,
  runMicromamba,
  writeMambarc
} from './runtime'

export type {
  CondaOverrides,
  RunMicromambaOptions,
  RuntimeLayout,
  RuntimeSettings
} from './runtime'

export { captureActivation, diffActivation } from './activation'
export type { ActivationSnapshot } from './activation'

export { acquireEnvironmentLock, ensureEnvironment, removeTree } from './ensure'
export type {
  EnsureEnvironmentInput,
  EnsureEnvironmentResult,
  EnsureProgressEvent,
  EnvironmentLock,
  SourcePackageInstaller
} from './ensure'

export { probeHostRequirements } from './host'
export type { HostProbeResult } from './host'

export { readEnvironmentIndex, updateEnvironmentEntry } from './index-store'
export type { EnvironmentEntryPatch, EnvironmentIndex, EnvironmentIndexEntry } from './index-store'

// gc and doctor
export { addReferrer, removeReferrer } from './index-store'
export { collectGarbage, trimPackageCache } from './gc'
export type { GarbageCollectionResult } from './gc'
export { checkEnvironment, parseLockPackage, repairEnvironment } from './doctor'
export type { EnvironmentCheck, LockPackage } from './doctor'

// source packages
export {
  createSourcePackageInstaller,
  fetchSourceArchive,
  installRSourcePackages,
  sourceArchiveUrls
} from './source-packages'
export type {
  FetchSourceArchiveOptions,
  SourceArchiveDownloader,
  SourcePackageInstallOptions,
  SourcePackageProgress
} from './source-packages'

// execution
export {
  EXECUTION_CONTRACT_VERSION,
  environmentCacheDir,
  environmentVariables,
  loadEnvironment,
  removeEnvironmentCache,
  resolveCommand,
  runInEnvironment,
  sanitizeHostEnvironment
} from './execution'
export type { EnvHandle, ExecutionOptions, RunOptions, RunResult } from './execution'
