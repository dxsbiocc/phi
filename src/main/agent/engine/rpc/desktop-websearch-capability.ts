import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuthStorage } from '@oh-my-pi/pi-ai'
import type { Settings } from '@oh-my-pi/pi-coding-agent'
import { ModelsConfigFile } from '@oh-my-pi/pi-coding-agent/config/models-config'
import {
  isCommandConfigValue,
  resolveConfigValue
} from '@oh-my-pi/pi-coding-agent/config/resolve-config-value'
import { loadEffectiveAuthAccountPolicyConfig } from '@oh-my-pi/pi-coding-agent/session/auth-broker-config'
import { discoverAuthStorage } from '@oh-my-pi/pi-ai/auth-broker/discover'

const MAX_CONFIG_BYTES = 4 * 1024 * 1024
export class DesktopWebSearchCapabilityError extends Error {
  constructor(reason: 'command' | 'config') {
    super(
      reason === 'command'
        ? 'Command-backed credentials or model headers are unsupported for desktop web search'
        : 'Desktop web search model configuration is invalid or exceeds supported bounds'
    )
    this.name = 'DesktopWebSearchCapabilityError'
  }
}
export interface DesktopWebSearchCapability {
  readonly auth: AuthStorage
  readonly modelsPath: string
  readonly cacheDbPath: string
  /** ModelRegistry installs its own resolver in its constructor; restore this before any hydration. */
  installResolver(): void
  assertCredentials(): void
}
/** The SDK still parses/selects credentials. This boundary admits only configurations it can own. */
export async function prepareDesktopWebSearchCapability(options: {
  settings: Settings
  agentDir: string
  resourceCwd: string
  privateDirectory: string
  onUnsupported(error: DesktopWebSearchCapabilityError): void
}): Promise<DesktopWebSearchCapability> {
  let blocked: DesktopWebSearchCapabilityError | undefined
  const reject = (reason: 'command' | 'config'): never => {
    blocked ??= new DesktopWebSearchCapabilityError(reason)
    options.onUnsupported(blocked)
    throw blocked
  }
  const check = (value: string | undefined): void => {
    if (isCommandConfigValue(value)) reject('command')
  }
  const headers = (values: Record<string, string> | undefined): void => {
    for (const value of Object.values(values ?? {})) check(value)
  }
  // Bound all native fallback/migration candidates before invoking the actual SDK loader.
  for (const name of ['models.yml', 'models.yaml', 'models.json']) {
    try {
      const info = await stat(join(options.agentDir, name))
      if (!info.isFile() || info.size > MAX_CONFIG_BYTES) reject('config')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reject('config')
    }
  }
  const file = ModelsConfigFile.relocate(join(options.agentDir, 'models.yml'))
  file.invalidate()
  const loaded = file.tryLoad()
  if (loaded.status === 'error') reject('config')
  const config = loaded.status === 'ok' ? loaded.value : {}
  for (const provider of Object.values(config.providers ?? {})) {
    check(provider.apiKey)
    headers(provider.headers)
    for (const model of provider.models ?? []) headers(model.headers)
    for (const override of Object.values(provider.modelOverrides ?? {})) headers(override.headers)
  }
  const bytes = boundedConfig(config, () => reject('config'))
  const modelsPath = join(options.privateDirectory, 'models.yml')
  await writeFile(modelsPath, bytes, { mode: 0o600, flag: 'wx' })
  const resolve = async (value: string): Promise<string | undefined> => {
    if (blocked) throw blocked
    check(value)
    return await resolveConfigValue(value)
  }
  const policy = await loadEffectiveAuthAccountPolicyConfig({
    settings: options.settings,
    cwd: options.resourceCwd,
    agentDir: options.agentDir
  })
  // Same actual discovery/store/policy helpers as the coding-agent SDK thin wrapper,
  // with its supported callback injection. Broker commands cannot run before this guard.
  const auth = await discoverAuthStorage({
    agentDir: options.agentDir,
    configValueResolver: resolve,
    accountPolicies: policy.accountPolicies,
    authStorageOptions: { defaultReservePct: policy.defaultReservePct }
  })
  const assertCredentials = (): void => {
    if (blocked) throw blocked
    for (const entry of auth.credentials.list())
      if (entry.credential.type === 'api_key') check(entry.credential.key)
  }
  try {
    assertCredentials()
  } catch (error) {
    auth.close()
    throw error
  }
  return {
    auth,
    modelsPath,
    cacheDbPath: join(options.privateDirectory, 'models.db'),
    installResolver() {
      auth.keys.setResolver(resolve)
    },
    assertCredentials
  }
}
function boundedConfig(value: unknown, fail: () => never): Buffer {
  let nodes = 0
  function visit(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 32) fail()
    if (
      item === null ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      return
    if (typeof item === 'string') {
      if (Buffer.byteLength(item) > MAX_CONFIG_BYTES) fail()
      return
    }
    if (
      !item ||
      typeof item !== 'object' ||
      ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))
    )
      fail()
    for (const child of Object.values(item)) visit(child, depth + 1)
  }
  visit(value, 0)
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  if (bytes.length > MAX_CONFIG_BYTES) fail()
  return bytes
}
