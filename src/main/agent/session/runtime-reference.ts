import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { ProjectLocation } from '../../../shared/projectLocation'
import { PINNED_OMP_VERSION } from '../engine/omp-version'

export const REMOTE_OMP_VERSION = PINNED_OMP_VERSION

export interface RemoteOmpScope {
  readonly hostProfileId: string
  readonly bindingHash: string
  readonly projectId: string
  readonly projectRoot: string
  readonly runtimeRoot: string
}

/** Verified locator only; live generations, credentials and capabilities never belong here. */
export interface RemoteOmpRuntimeRef extends RemoteOmpScope {
  readonly kind: 'remote-omp'
  readonly version: 1
  readonly durableSessionKey: string
  readonly ompSessionId: string
  readonly journalBasename: string
  readonly ompVersion: typeof REMOTE_OMP_VERSION
  readonly checkpoint?: {
    readonly leafId: string | null
    readonly lastEntryId?: string
    readonly verifiedAt: string
  }
}

export interface KernelLocalRuntimeRef {
  readonly kind: 'phi-kernel'
  readonly version: 1
  readonly kernelSessionId: string
  readonly host: {
    readonly kind: 'local'
    readonly agentDir: string
  }
}

export interface KernelRemoteRuntimeRef {
  readonly kind: 'phi-kernel'
  readonly version: 1
  readonly kernelSessionId: string
  readonly host: {
    readonly kind: 'ssh'
    readonly hostProfileId: string
    readonly projectId: string
    readonly projectRoot: string
    readonly runtimeRoot: string
    readonly home: string
    readonly agentDir: string
  }
}

export type KernelRuntimeRef = KernelLocalRuntimeRef | KernelRemoteRuntimeRef
export type PhiRuntimeRef = RemoteOmpRuntimeRef
export type RuntimeRecoveryErrorCode =
  | 'INVALID_RUNTIME_REFERENCE'
  | 'PROJECT_MISMATCH'
  | 'HOST_IDENTITY_CHANGED'
  | 'STALE_GENERATION'
  | 'CANCELLED'
  | 'REMOTE_OPERATION_REQUIRED'
  | 'KERNEL_OPERATION_REQUIRED'

export interface RuntimeRecoveryDiagnostic {
  readonly code: RuntimeRecoveryErrorCode
  readonly message: string
}

export class RuntimeReferenceError extends Error {
  constructor(
    readonly code: RuntimeRecoveryErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'RuntimeReferenceError'
  }
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const hash = /^[a-f0-9]{64}$/
// Host profiles imported from ~/.ssh/config are `ssh-config:<alias>`.
const hostProfileId = /^(?:ssh-config:)?[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const scopeKeys = [
  'hostProfileId',
  'bindingHash',
  'projectId',
  'projectRoot',
  'runtimeRoot'
] as const
const referenceKeys = [
  ...scopeKeys,
  'kind',
  'version',
  'durableSessionKey',
  'ompSessionId',
  'journalBasename',
  'ompVersion'
]

const kernelReferenceKeys = ['kind', 'version', 'kernelSessionId', 'host'] as const

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safePathText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
}

function canonicalPath(value: unknown, allowRoot: boolean): value is string {
  return (
    safePathText(value) &&
    posix.isAbsolute(value) &&
    (allowRoot || value !== '/') &&
    (value === '/' || !value.endsWith('/')) &&
    posix.normalize(value) === value
  )
}

function canonicalLocalAgentDir(value: unknown): value is string {
  if (canonicalPath(value, false)) return true
  if (!safePathText(value) || value.endsWith('\\') || win32.normalize(value) !== value) return false

  const { root } = win32.parse(value)
  const drive = /^[a-z]:\\$/iu.test(root)
  const share = /^\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+\\$/u.test(root) && !root.startsWith('\\\\.\\')
  return (drive || share) && !/[/:*?"<>|]/u.test(value.slice(root.length))
}

export function remoteOmpDurableSessionKey(scope: RemoteOmpScope, sessionId: string): string {
  if (
    !scope ||
    Object.values(scope).some((value) => typeof value !== 'string') ||
    !identifier.test(sessionId) ||
    !hostProfileId.test(scope.hostProfileId) ||
    !hash.test(scope.bindingHash) ||
    !identifier.test(scope.projectId) ||
    !canonicalPath(scope.projectRoot, true) ||
    !canonicalPath(scope.runtimeRoot, false)
  ) {
    throw new RuntimeReferenceError('INVALID_RUNTIME_REFERENCE', '远程会话定位信息无效')
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        1,
        scope.hostProfileId,
        scope.bindingHash,
        scope.projectId,
        scope.projectRoot,
        scope.runtimeRoot
      ])
    )
    .digest('hex')
  return `${digest}/${sessionId}`
}

/** Validate unknown disk/server input and return a fresh immutable, secret-free value. */
export function parseRuntimeReference(value: unknown, sessionId: string): RemoteOmpRuntimeRef {
  const invalid = (): never => {
    throw new RuntimeReferenceError(
      'INVALID_RUNTIME_REFERENCE',
      '远程会话定位信息损坏，需要显式恢复'
    )
  }
  if (
    !record(value) ||
    Object.keys(value).some((key) => !referenceKeys.includes(key) && key !== 'checkpoint') ||
    referenceKeys.some((key) => !Object.hasOwn(value, key)) ||
    value.kind !== 'remote-omp' ||
    value.version !== 1 ||
    value.ompVersion !== REMOTE_OMP_VERSION ||
    typeof value.ompSessionId !== 'string' ||
    !identifier.test(value.ompSessionId) ||
    typeof value.journalBasename !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.jsonl$/.test(value.journalBasename) ||
    value.journalBasename.includes('..')
  )
    return invalid()
  const scope = Object.fromEntries(
    scopeKeys.map((key) => [key, value[key]])
  ) as unknown as RemoteOmpScope
  // The key also binds this locator to the stable Phi session, never to a generation.
  if (value.durableSessionKey !== remoteOmpDurableSessionKey(scope, sessionId)) return invalid()
  let checkpoint: RemoteOmpRuntimeRef['checkpoint']
  if (Object.hasOwn(value, 'checkpoint')) {
    const item = value.checkpoint
    if (
      !record(item) ||
      Object.keys(item).some((key) => !['leafId', 'lastEntryId', 'verifiedAt'].includes(key)) ||
      !(
        item.leafId === null ||
        (typeof item.leafId === 'string' && identifier.test(item.leafId))
      ) ||
      (item.lastEntryId !== undefined &&
        !(typeof item.lastEntryId === 'string' && identifier.test(item.lastEntryId))) ||
      typeof item.verifiedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T/.test(item.verifiedAt) ||
      !Number.isFinite(Date.parse(item.verifiedAt))
    )
      return invalid()
    checkpoint = Object.freeze({
      leafId: item.leafId as string | null,
      ...(item.lastEntryId === undefined ? {} : { lastEntryId: item.lastEntryId as string }),
      verifiedAt: item.verifiedAt
    })
  }
  return Object.freeze({
    ...scope,
    kind: 'remote-omp',
    version: 1,
    durableSessionKey: value.durableSessionKey as string,
    ompSessionId: value.ompSessionId,
    journalBasename: value.journalBasename,
    ompVersion: REMOTE_OMP_VERSION,
    ...(checkpoint ? { checkpoint } : {})
  })
}

function invalidKernelReference(): never {
  throw new RuntimeReferenceError('INVALID_RUNTIME_REFERENCE', '内核会话定位信息损坏，需要显式恢复')
}

function parseLocalKernelHost(
  kernelSessionId: string,
  host: Record<string, unknown>
): KernelLocalRuntimeRef {
  if (
    Object.keys(host).sort().join(',') !== 'agentDir,kind' ||
    !canonicalLocalAgentDir(host.agentDir)
  ) {
    return invalidKernelReference()
  }
  return Object.freeze({
    kind: 'phi-kernel',
    version: 1,
    kernelSessionId,
    host: Object.freeze({ kind: 'local', agentDir: host.agentDir })
  })
}

function parseRemoteKernelHost(
  kernelSessionId: string,
  host: Record<string, unknown>
): KernelRemoteRuntimeRef {
  if (
    Object.keys(host).sort().join(',') !==
      'agentDir,home,hostProfileId,kind,projectId,projectRoot,runtimeRoot' ||
    typeof host.hostProfileId !== 'string' ||
    !hostProfileId.test(host.hostProfileId) ||
    typeof host.projectId !== 'string' ||
    !identifier.test(host.projectId) ||
    !canonicalPath(host.projectRoot, true) ||
    !canonicalPath(host.runtimeRoot, false) ||
    !canonicalPath(host.home, false) ||
    !canonicalPath(host.agentDir, false)
  ) {
    return invalidKernelReference()
  }
  return Object.freeze({
    kind: 'phi-kernel',
    version: 1,
    kernelSessionId,
    host: Object.freeze({
      kind: 'ssh',
      hostProfileId: host.hostProfileId,
      projectId: host.projectId,
      projectRoot: host.projectRoot,
      runtimeRoot: host.runtimeRoot,
      home: host.home,
      agentDir: host.agentDir
    })
  })
}

export function parseKernelRuntimeReference(value: unknown): KernelRuntimeRef {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !(kernelReferenceKeys as readonly string[]).includes(key)) ||
    value.kind !== 'phi-kernel' ||
    value.version !== 1 ||
    typeof value.kernelSessionId !== 'string' ||
    !identifier.test(value.kernelSessionId) ||
    !record(value.host)
  ) {
    return invalidKernelReference()
  }
  if (value.host.kind === 'local') return parseLocalKernelHost(value.kernelSessionId, value.host)
  if (value.host.kind === 'ssh') return parseRemoteKernelHost(value.kernelSessionId, value.host)
  return invalidKernelReference()
}

export function assertRuntimeScope(ref: RemoteOmpRuntimeRef, scope: RemoteOmpScope): void {
  for (const key of scopeKeys) {
    if (ref[key] === scope[key]) continue
    throw new RuntimeReferenceError(
      key === 'hostProfileId' || key === 'bindingHash'
        ? 'HOST_IDENTITY_CHANGED'
        : 'PROJECT_MISMATCH',
      '远程会话绑定发生变化，需要显式恢复'
    )
  }
}

/**
 * Guards desktop-side access to a session's history. A kernel on this machine
 * keeps its history locally but in its own store, so only callers that handle
 * that store (deletion) pass `allowLocalKernel`.
 */
/** A remote fork stays on the server its source runs on. */
export function kernelForkAccess(
  fork: KernelRuntimeRef | undefined,
  source: KernelRuntimeRef | undefined
): { allowLocalKernel: boolean; allowRemoteKernel: boolean } {
  return {
    allowLocalKernel: fork?.host.kind === 'local',
    allowRemoteKernel: fork?.host.kind === 'ssh' && source?.host.kind === 'ssh'
  }
}

export function assertLocalRuntimeAccess(
  manifest: {
    runtimeRef?: PhiRuntimeRef
    kernelRuntimeRef?: KernelRuntimeRef
    runtimeRecoveryError?: RuntimeRecoveryDiagnostic
  },
  options: { allowLocalKernel?: boolean; allowRemoteKernel?: boolean } = {}
): void {
  if (manifest.runtimeRecoveryError)
    throw new RuntimeReferenceError(
      manifest.runtimeRecoveryError.code,
      manifest.runtimeRecoveryError.message
    )
  const localKernel = manifest.kernelRuntimeRef?.host.kind === 'local'
  if (
    manifest.runtimeRef ||
    (manifest.kernelRuntimeRef && !localKernel && !options.allowRemoteKernel)
  )
    throw new RuntimeReferenceError(
      'REMOTE_OPERATION_REQUIRED',
      '远程会话需要通过已验证的服务器操作，不能使用本地底层会话'
    )
  if (localKernel && !options.allowLocalKernel)
    throw new RuntimeReferenceError(
      'KERNEL_OPERATION_REQUIRED',
      '该会话由本地内核管理，暂不支持这个操作'
    )
}

/** Lexical server locator only. Never pass this value to desktop filesystem APIs. */
export function remoteOmpJournalPath(
  ref: Pick<RemoteOmpRuntimeRef, 'runtimeRoot' | 'durableSessionKey' | 'journalBasename'>
): string {
  return posix.join(
    ref.runtimeRoot,
    'omp-sessions',
    ref.durableSessionKey,
    'journals',
    ref.journalBasename
  )
}

export function assertRuntimeReferenceProject(
  manifest: {
    kind: string
    projectId: string | null
    projectLocation?: ProjectLocation
    runtimeSessionPath?: string
  },
  ref: RemoteOmpScope
): void {
  if (
    manifest.runtimeSessionPath ||
    manifest.kind !== 'project' ||
    manifest.projectId !== ref.projectId ||
    manifest.projectLocation?.kind !== 'ssh' ||
    manifest.projectLocation.canonicalRoot !== ref.projectRoot
  ) {
    throw new RuntimeReferenceError('PROJECT_MISMATCH', '远程会话与项目绑定不一致，需要显式恢复')
  }
  if (manifest.projectLocation.hostProfileId !== ref.hostProfileId) {
    throw new RuntimeReferenceError(
      'HOST_IDENTITY_CHANGED',
      '远程会话的主机绑定已改变，需要显式恢复'
    )
  }
}

export function assertKernelRuntimeReferenceProject(
  manifest: {
    kind: string
    projectId: string | null
    projectLocation?: ProjectLocation
    runtimeSessionPath?: string
  },
  ref: KernelRuntimeRef
): void {
  if (ref.host.kind === 'local') {
    if (manifest.projectLocation?.kind === 'ssh' || manifest.runtimeSessionPath) {
      throw new RuntimeReferenceError('PROJECT_MISMATCH', '本地内核会话与项目绑定不一致')
    }
    return
  }
  if (
    manifest.runtimeSessionPath ||
    manifest.kind !== 'project' ||
    manifest.projectId !== ref.host.projectId ||
    manifest.projectLocation?.kind !== 'ssh' ||
    manifest.projectLocation.canonicalRoot !== ref.host.projectRoot
  ) {
    throw new RuntimeReferenceError('PROJECT_MISMATCH', '远程内核会话与项目绑定不一致')
  }
  if (manifest.projectLocation.hostProfileId !== ref.host.hostProfileId) {
    throw new RuntimeReferenceError('HOST_IDENTITY_CHANGED', '远程内核主机绑定已改变')
  }
}

/** Only denies local IO. Damaged version/binding/extra fields never grant remote authority here. */
export function excludesLocalJournalPath(value: unknown, path: string): boolean {
  if (
    !record(value) ||
    !canonicalPath(value.runtimeRoot, false) ||
    typeof value.durableSessionKey !== 'string' ||
    !/^[a-f0-9]{64}\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.durableSessionKey) ||
    typeof value.journalBasename !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.jsonl$/.test(value.journalBasename) ||
    value.journalBasename.includes('..') ||
    !posix.isAbsolute(path)
  )
    return false
  return (
    posix.normalize(path) ===
    remoteOmpJournalPath({
      runtimeRoot: value.runtimeRoot,
      durableSessionKey: value.durableSessionKey,
      journalBasename: value.journalBasename
    })
  )
}
