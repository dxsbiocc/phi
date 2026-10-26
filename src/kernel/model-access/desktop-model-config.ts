import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parse as parseYaml } from 'yaml'

export const DESKTOP_BROKER_API_KEY_CONFIG = 'PHI_DESKTOP_MODEL_ACCESS_BROKER'

export interface DesktopBrokerModelsConfigProjection {
  modelsPath: string | undefined
  credentialProviders: ReadonlySet<string>
  authHeaderProviders: ReadonlySet<string>
  sync(): void
  dispose(): void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function unchanged(modelsPath: string | undefined): DesktopBrokerModelsConfigProjection {
  return {
    modelsPath,
    credentialProviders: new Set(),
    authHeaderProviders: new Set(),
    sync: () => undefined,
    dispose: () => undefined
  }
}

function readModelsConfig(modelsPath: string): Record<string, unknown> | undefined {
  try {
    return record(parseYaml(readFileSync(modelsPath, 'utf8')))
  } catch {
    return undefined
  }
}

function needsBrokerCredential(provider: Record<string, unknown>): boolean {
  return (
    Array.isArray(provider.models) &&
    provider.models.length > 0 &&
    !(typeof provider.apiKey === 'string' && provider.apiKey.length > 0) &&
    provider.auth !== 'none' &&
    provider.auth !== 'oauth'
  )
}

function applyBrokerMarkers(
  config: Record<string, unknown>,
  credentialProviders: Set<string>,
  authHeaderProviders: Set<string>
): void {
  credentialProviders.clear()
  authHeaderProviders.clear()
  const providers = record(config.providers)
  if (!providers) return
  for (const [providerName, value] of Object.entries(providers)) {
    const provider = record(value)
    if (!provider || !needsBrokerCredential(provider)) continue
    credentialProviders.add(providerName)
    if (provider.authHeader === true) {
      authHeaderProviders.add(providerName)
      provider.authHeader = false
    }
    provider.apiKey = DESKTOP_BROKER_API_KEY_CONFIG
  }
}

/**
 * ModelRegistry validates custom providers before the desktop broker can hydrate its credentials.
 * Give validation a non-secret marker for custom providers whose real key comes from the broker.
 * The mode-0600 projection follows source refreshes and is removed when model access closes.
 */
export function projectDesktopBrokerModelsConfig(
  modelsPath: string | undefined
): DesktopBrokerModelsConfigProjection {
  if (!modelsPath) return unchanged(modelsPath)
  // Preserve ModelRegistry's native missing/invalid-file handling and diagnostics.
  const config = readModelsConfig(modelsPath)
  if (!config) return unchanged(modelsPath)

  const credentialProviders = new Set<string>()
  const authHeaderProviders = new Set<string>()
  applyBrokerMarkers(config, credentialProviders, authHeaderProviders)
  if (credentialProviders.size === 0) return unchanged(modelsPath)

  const directory = mkdtempSync(join(tmpdir(), 'phi-kernel-model-access-'))
  const projectedPath = join(directory, 'models.yml')
  const writeProjection = (contents: string, exclusive = false): void =>
    writeFileSync(projectedPath, contents, {
      mode: 0o600,
      ...(exclusive ? { flag: 'wx' as const } : {})
    })
  try {
    writeProjection(JSON.stringify(config), true)
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  let disposed = false
  return {
    modelsPath: projectedPath,
    credentialProviders,
    authHeaderProviders,
    sync() {
      const refreshed = readModelsConfig(modelsPath)
      if (refreshed) {
        applyBrokerMarkers(refreshed, credentialProviders, authHeaderProviders)
        writeProjection(JSON.stringify(refreshed))
        return
      }
      credentialProviders.clear()
      authHeaderProviders.clear()
      try {
        writeProjection(readFileSync(modelsPath, 'utf8'))
      } catch {
        writeProjection('{}')
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
