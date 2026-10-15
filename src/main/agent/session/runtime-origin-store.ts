import { createHash } from 'node:crypto'
import { getPhiAgentDir } from '../runtime-paths'
import type { PhiSessionManifest } from './session-store'
import {
  assertRuntimeReferenceProject,
  remoteOmpDurableSessionKey,
  type RemoteOmpScope
} from './runtime-reference'
import { readRecoveryFile, recoveryFile, writeRecoveryFile } from './private-recovery-file'

export interface RuntimeSessionOrigin {
  readonly runtimeSessionId: string
  readonly phiSessionId: string
  readonly projectId: string | null
  readonly cwd: string
  readonly remoteScope?: RemoteOmpScope
  /** Trusted configuration text; null records the default, separate from the resolved server path. */
  readonly configuredRuntimeRoot?: string | null
}
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
function parse(value: unknown): RuntimeSessionOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid runtime origin')
  const data = value as Record<string, unknown>
  if (
    Object.keys(data).some(
      (key) =>
        ![
          'runtimeSessionId',
          'phiSessionId',
          'projectId',
          'cwd',
          'remoteScope',
          'configuredRuntimeRoot'
        ].includes(key)
    ) ||
    !id(data.runtimeSessionId) ||
    !id(data.phiSessionId) ||
    (data.projectId !== null && !id(data.projectId)) ||
    typeof data.cwd !== 'string' ||
    data.cwd.length > 4096 ||
    !data.cwd.startsWith('/') ||
    Array.from(data.cwd).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error('Invalid runtime origin')
  let remoteScope: RemoteOmpScope | undefined
  if (data.remoteScope !== undefined) {
    if (
      !data.remoteScope ||
      typeof data.remoteScope !== 'object' ||
      Array.isArray(data.remoteScope) ||
      Object.keys(data.remoteScope).sort().join(',') !==
        'bindingHash,hostProfileId,projectId,projectRoot,runtimeRoot'
    )
      throw new Error('Invalid runtime origin scope')
    remoteScope = Object.freeze({ ...(data.remoteScope as RemoteOmpScope) })
    remoteOmpDurableSessionKey(remoteScope, data.phiSessionId)
    if (data.projectId !== remoteScope.projectId) throw new Error('Invalid runtime origin project')
    if (
      data.configuredRuntimeRoot !== null &&
      (typeof data.configuredRuntimeRoot !== 'string' ||
        !data.configuredRuntimeRoot ||
        data.configuredRuntimeRoot.length > 4096 ||
        Array.from(data.configuredRuntimeRoot).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ))
    )
      throw new Error('Invalid runtime origin configuration')
  } else if (data.configuredRuntimeRoot !== undefined) {
    throw new Error('Local runtime origin cannot carry remote configuration')
  }
  return Object.freeze({
    runtimeSessionId: data.runtimeSessionId,
    phiSessionId: data.phiSessionId,
    projectId: data.projectId as string | null,
    cwd: data.cwd,
    ...(remoteScope
      ? { remoteScope, configuredRuntimeRoot: data.configuredRuntimeRoot as string | null }
      : {})
  })
}
function parts(runtimeSessionId: string): readonly string[] {
  if (!id(runtimeSessionId)) throw new Error('Invalid runtime origin identifier')
  return ['runtime-origins', createHash('sha256').update(runtimeSessionId).digest('hex') + '.json']
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/** Main-owned provenance only. Register after verified session creation; never from tool/renderer input. */
export function registerRuntimeSessionOrigin(
  input: RuntimeSessionOrigin,
  agentDir = getPhiAgentDir()
): string {
  const origin = parse(input)
  const path = recoveryFile(agentDir, parts(origin.runtimeSessionId), true)
  try {
    const previous = parse(readRecoveryFile(path))
    if (JSON.stringify(previous) !== JSON.stringify(origin))
      throw new Error('Runtime origin cannot be retargeted')
    return path
  } catch (error) {
    if (!missing(error)) throw error
  }
  writeRecoveryFile(path, origin)
  return path
}

/** Cold origins grant no live tool, approval, job execution or wakeup authority. */
export function resolveRuntimeSessionOrigin(
  runtimeSessionId: string,
  options: {
    readManifest(phiSessionId: string): PhiSessionManifest | null | undefined
    resolveRemoteScope(manifest: PhiSessionManifest): RemoteOmpScope | undefined
    /** Undefined means unavailable/unproved; explicitly return null for the trusted default. */
    resolveConfiguredRuntimeRoot?(manifest: PhiSessionManifest): string | null | undefined
  },
  agentDir = getPhiAgentDir()
): { phiSessionId: string; cwd: string } | undefined {
  try {
    const origin = parse(readRecoveryFile(recoveryFile(agentDir, parts(runtimeSessionId), false)))
    if (origin.runtimeSessionId !== runtimeSessionId) return undefined
    const manifest = options.readManifest(origin.phiSessionId)
    if (
      !manifest ||
      manifest.sessionId !== origin.phiSessionId ||
      (manifest.projectId ?? null) !== origin.projectId ||
      manifest.cwd !== origin.cwd
    )
      return undefined
    if (origin.remoteScope) {
      assertRuntimeReferenceProject(manifest, origin.remoteScope)
      if (options.resolveConfiguredRuntimeRoot?.(manifest) !== origin.configuredRuntimeRoot)
        return undefined
      const current = options.resolveRemoteScope(manifest)
      if (!current) return undefined
      remoteOmpDurableSessionKey(current, origin.phiSessionId)
      if (
        Object.entries(origin.remoteScope).some(
          ([key, value]) => current[key as keyof RemoteOmpScope] !== value
        )
      )
        return undefined
    } else if (
      manifest.projectLocation?.kind === 'ssh' ||
      manifest.runtimeRef ||
      manifest.runtimeRecoveryError
    )
      return undefined
    return Object.freeze({ phiSessionId: origin.phiSessionId, cwd: origin.cwd })
  } catch {
    return undefined
  }
}
