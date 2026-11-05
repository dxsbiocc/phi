export { environmentSpecSchema, envMetadataSchema } from './schemas'

export {
  ENVIRONMENT_CONTRACT_VERSION,
  ENV_STATUS_TRANSITIONS,
  PHI_LOCK_PLATFORMS,
  PHI_PLATFORMS,
  canTransition,
  computeEnvId,
  cloneCondaDependency,
  condaSpecOf,
  condaSubdir,
  currentPlatform,
  findPlatform,
  isPipDependency,
  resolveManagedLockPlatform,
  lockSha256,
  normalizeLockText,
  parseEnvironmentRef,
  parseEnvironmentSpec,
  parseExplicitLock,
  parseLockDownloadBytes
} from './contract'

export type {
  CondaDependency,
  CondaPipDependency,
  CondaPlatformDependency,
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
  ManagedLockResolution,
  PhiLockPlatform,
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

export { prefixExecutable } from './prefix-executable'

export {
  decodeWslOutput,
  parseWslList,
  probeWsl,
  readWslRuntime,
  requireReadyWsl,
  toLinuxPath,
  toUncPath,
  toWindowsPath,
  toWslPath,
  usesWslEnvironment,
  wslRequiredMessage,
  wslProcessEnvironment,
  wslEnvironmentPrefix,
  wslRuntimeDirectory,
  wslSpawnArgv
} from './wsl'
export type { ReadyWsl, WslProbe, WslRuntime, WslSpawnPlan } from './wsl'

export { captureActivation, diffActivation } from './activation'
export type { ActivationSnapshot } from './activation'

export {
  acquireEnvironmentLock,
  ensureEnvironment,
  removeManagedEnvironmentPrefix,
  removeTree
} from './ensure'
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
  prepareEnvironmentCommand,
  removeEnvironmentCache,
  resolveCommand,
  runInEnvironment,
  sanitizeHostEnvironment
} from './execution'
export type {
  EnvHandle,
  EnvironmentCommand,
  ExecutionOptions,
  RunOptions,
  RunResult
} from './execution'
