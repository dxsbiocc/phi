import { join } from 'node:path'

import type { JsonValue } from '../../../shared/kernel-protocol'
import { getSessionDir, type PhiSessionManifest } from '../session/session-store'
import { recordKernelHistoryAdoption, type KernelHistoryPlan } from './kernel-history'
import type { PhiSessionCreateParams } from './types'

export function kernelHistoryAdoptionRequest(
  params: PhiSessionCreateParams,
  manifest: PhiSessionManifest,
  plan: Extract<KernelHistoryPlan, { action: 'adopt-local' | 'adopt-remote' }>
): JsonValue {
  return {
    source: plan.source,
    ...(manifest.title ? { title: manifest.title } : {}),
    ...(params.model ? { model: { provider: params.model.provider, id: params.model.id } } : {}),
    ...(manifest.thinkingLevel ? { thinkingLevel: manifest.thinkingLevel } : {})
  }
}

export function verifiedKernelAdoption(value: JsonValue): {
  adoptedId: string
  sourceSha256: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Kernel adoption returned a non-object result.')
  }
  const adoptedId = typeof value.sessionId === 'string' ? value.sessionId : undefined
  if (!adoptedId) throw new TypeError('Kernel adoption omitted sessionId.')
  const migration = value.migration
  const sourceSha256 =
    migration && typeof migration === 'object' && !Array.isArray(migration)
      ? migration.sourceSha256
      : undefined
  if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sourceSha256)) {
    throw new TypeError('Kernel adoption omitted the verified source SHA256.')
  }
  return { adoptedId, sourceSha256 }
}

/** Publishes rollback ownership only after the kernel has verified and opened its adopted copy. */
export async function publishKernelHistoryAdoption(input: {
  readonly params: PhiSessionCreateParams & { phiSessionId: string }
  readonly plan: Extract<KernelHistoryPlan, { action: 'adopt-local' | 'adopt-remote' }>
  readonly adoptedId: string
  readonly runtimeAgentDir: string
  readonly sourceSha256: string
}): Promise<void> {
  const { params, plan, adoptedId, runtimeAgentDir, sourceSha256 } = input
  const phiSessionDirectory = getSessionDir(params.phiSessionId)
  await recordKernelHistoryAdoption({
    plan,
    phiSessionDirectory,
    // RPC diagnostics are desktop evidence, so remote adoption stores them beside the Phi record.
    adoptedSessionDirectory: params.remoteProject
      ? phiSessionDirectory
      : join(runtimeAgentDir, 'phi-kernel', 'sessions', adoptedId),
    kernelSessionId: adoptedId,
    host: params.remoteProject ? params.remoteProject.location.hostProfileId : 'local',
    // Rollback resolves the kernel journal below the trusted kernel agent directory.
    runtimeRoot: runtimeAgentDir,
    sourceSha256
  })
}
