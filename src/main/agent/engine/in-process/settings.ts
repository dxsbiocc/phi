import { Settings } from '@oh-my-pi/pi-coding-agent'
import { register } from '@oh-my-pi/pi-coding-agent/config/registry'
import {
  resolveConfiguredModelPatterns,
  rolePriorityDefaults
} from '@oh-my-pi/pi-coding-agent/config/model-resolver'
import { cfgExtensions } from '@oh-my-pi/pi-coding-agent/extensibility/settings'
import {
  cfgMcpEnableProjectConfig,
  cfgMcpNotifications
} from '@oh-my-pi/pi-coding-agent/mcp/settings'
import { cfgMemoryBackend } from '@oh-my-pi/pi-coding-agent/memory-backend/settings'
import {
  cfgCompactionEnabled,
  cfgCompactionMethodOrder,
  cfgCompactionModelThresholds,
  cfgCompactionModelThresholdsEnabled,
  cfgCompactionThresholdPercent,
  cfgCompactionThresholdTokens
} from '@oh-my-pi/pi-coding-agent/session/context-settings'
import { cfgRetryFallbackChains } from '@oh-my-pi/pi-coding-agent/session/settings'
import { isRegisteredSearchEngine } from '@oh-my-pi/pi-coding-agent/web/search/provider'
import {
  cfgSearxngBasicPassword,
  cfgSearxngBasicUsername,
  cfgSearxngEndpoint,
  cfgSearxngEngines,
  cfgSearxngToken
} from '@oh-my-pi/pi-coding-agent/web/settings'
import { DEFAULT_COMPACTION_METHOD_ORDER, resolveCompactionMethodOrder } from '../omp-internals'
import { SEARCH_PROVIDER_CHOICES } from '../omp-web-search'

import type { PhiCompactionSettings, PhiSettings, PhiWebSearchProvider } from '../types'

const autoCompactionBaselines = new WeakMap<Settings, PhiCompactionSettings>()
const providerIds = SEARCH_PROVIDER_CHOICES.map(({ value }) => value)
const providerIdSet = new Set<string>(providerIds)

// OMP's role chain stores effective candidates, losing Phi's preferred prefix
// and explicit exclusions. Keep their exact shape only while that chain matches.
const cfgPhiWebSearch = register({
  id: 'phi.webSearch',
  type: 'record',
  default: {} as Record<string, string[]>
})

function providerSelectors(provider: PhiWebSearchProvider): string[] {
  switch (provider) {
    case 'gemini':
      return [
        'google-gemini-cli/gemini-2.5-flash',
        'google-antigravity/gemini-2.5-flash',
        'google/gemini-2.5-flash'
      ]
    case 'anthropic':
      return ['anthropic/claude-haiku-4-5']
    case 'codex':
      return ['openai-codex/gpt-5.6-luna']
    case 'xai':
      return ['xai/grok-4.5']
    default:
      return isRegisteredSearchEngine(provider) ? [`web/${provider}`] : []
  }
}

function selectorProvider(selector: string): PhiWebSearchProvider | undefined {
  const [provider, modelWithThinking] = selector.split('/')
  const model = modelWithThinking?.split(':')[0]
  if (provider === 'web' && model && providerIdSet.has(model)) return model as PhiWebSearchProvider
  if (
    provider === 'google-gemini-cli' ||
    provider === 'google-antigravity' ||
    provider === 'google'
  )
    return 'gemini'
  if (provider === 'anthropic') return 'anthropic'
  if (provider === 'openai-codex') return 'codex'
  if (provider === 'xai' || provider === 'xai-oauth') return 'xai'
  return undefined
}

function webSelectors(settings: Settings): string[] {
  const role = settings.getModelRole('web')
  const fallbacks = cfgRetryFallbackChains.get(settings).web ?? rolePriorityDefaults('web')
  // Each comma list is one SDK attempt's availability alternatives, not a
  // retry sequence. Phi displays all configured providers before auth filtering.
  return resolveConfiguredModelPatterns([...(role ? [role] : []), ...fallbacks], settings)
}

function knownProviders(value: unknown): value is PhiWebSearchProvider[] {
  return (
    Array.isArray(value) && value.every((id) => typeof id === 'string' && providerIdSet.has(id))
  )
}

function readWebSearchProviders(settings: Settings): {
  order: PhiWebSearchProvider[]
  excluded: PhiWebSearchProvider[]
} {
  const selectors = webSelectors(settings)
  const saved = cfgPhiWebSearch.get(settings)
  if (
    knownProviders(saved.order) &&
    knownProviders(saved.excluded) &&
    Array.isArray(saved.selectors) &&
    saved.selectors.length === selectors.length &&
    saved.selectors.every((selector, index) => selector === selectors[index])
  ) {
    return { order: [...saved.order], excluded: [...saved.excluded] }
  }
  if (
    !settings.getModelRole('web') &&
    !Object.hasOwn(cfgRetryFallbackChains.get(settings), 'web')
  ) {
    return { order: [], excluded: [] }
  }
  // The SDK has already migrated legacy keys by this point. Reflect the
  // surviving configured candidates (including alias/comma alternatives); the
  // original prefix cannot be recovered without the retired source values.
  const order = [...new Set(selectors.flatMap((selector) => selectorProvider(selector) ?? []))]
  return { order, excluded: providerIds.filter((provider) => !order.includes(provider)) }
}

function globalFallbackChains(settings: Settings): Record<string, string[]> {
  const retry = settings.getGlobalSettings().retry
  if (!retry || typeof retry !== 'object' || Array.isArray(retry) || !('fallbackChains' in retry))
    return {}
  const chains = retry.fallbackChains
  return chains && typeof chains === 'object' && !Array.isArray(chains)
    ? (chains as Record<string, string[]>)
    : {}
}

function readRawCompactionSettings(settings: Settings): PhiCompactionSettings {
  return {
    enabled: cfgCompactionEnabled.get(settings),
    thresholdPercent: cfgCompactionThresholdPercent.get(settings),
    thresholdTokens: cfgCompactionThresholdTokens.get(settings),
    methodOrder: [...cfgCompactionMethodOrder.get(settings)]
  }
}

export function createPhiSettings(settings: Settings): PhiSettings {
  return {
    compaction: {
      read: () => {
        const values = readRawCompactionSettings(settings)
        return { ...values, methodOrder: resolveCompactionMethodOrder(values.methodOrder) }
      },
      override: (values) => {
        cfgCompactionEnabled.override(settings, values.enabled)
        cfgCompactionThresholdPercent.override(settings, values.thresholdPercent)
        cfgCompactionThresholdTokens.override(settings, values.thresholdTokens)
        cfgCompactionMethodOrder.override(settings, [...values.methodOrder])
      }
    },
    webSearch: {
      read: () => ({
        ...readWebSearchProviders(settings),
        endpoint: cfgSearxngEndpoint.get(settings),
        engines: cfgSearxngEngines.get(settings)
      }),
      write: (values) => {
        const excluded = new Set(values.excluded)
        const allowed = [...new Set([...values.order, ...providerIds])].filter(
          (id) => !excluded.has(id)
        )
        const selectors = allowed.flatMap(providerSelectors)
        if (!selectors.length) throw new Error('Select at least one web search provider')
        settings.setModelRole('web', selectors[0])
        cfgRetryFallbackChains.set(settings, {
          ...globalFallbackChains(settings),
          web: selectors.slice(1)
        })
        cfgPhiWebSearch.set(settings, {
          order: [...values.order],
          excluded: [...values.excluded],
          selectors
        })
        cfgSearxngEndpoint.set(settings, values.endpoint)
        cfgSearxngEngines.set(settings, values.engines)
      },
      readSearxngCredentials: () => ({
        endpoint: cfgSearxngEndpoint.get(settings),
        token: cfgSearxngToken.get(settings),
        basicUsername: cfgSearxngBasicUsername.get(settings),
        basicPassword: cfgSearxngBasicPassword.get(settings)
      })
    },
    mcp: {
      read: () => ({
        enableProjectConfig: cfgMcpEnableProjectConfig.get(settings) ?? true,
        notifications: cfgMcpNotifications.get(settings)
      })
    },
    extensions: {
      read: () => ({
        configured: [...cfgExtensions.get(settings)],
        sourceLevel: settings.extensionsSourceLevel()
      })
    },
    memory: { useLocalBackend: () => cfgMemoryBackend.override(settings, 'local') },
    flush: () => settings.flush()
  }
}

export function applyAutoCompactionOverrides(
  settings: Settings,
  overrides: { enabled?: boolean; thresholdPercent?: number }
): void {
  let baseline = autoCompactionBaselines.get(settings)
  if (!baseline) {
    baseline = readRawCompactionSettings(settings)
    autoCompactionBaselines.set(settings, baseline)
  }

  const methodOrder =
    overrides.enabled === true && resolveCompactionMethodOrder(baseline.methodOrder).length === 0
      ? [...DEFAULT_COMPACTION_METHOD_ORDER]
      : [...baseline.methodOrder]
  createPhiSettings(settings).compaction.override({
    enabled: overrides.enabled ?? baseline.enabled,
    thresholdPercent: overrides.thresholdPercent ?? baseline.thresholdPercent,
    thresholdTokens: overrides.thresholdPercent === undefined ? baseline.thresholdTokens : -1,
    methodOrder
  })
}

/** Controlled RPC policy cannot silently discard desktop model-specific threshold rules. */
export function assertRpcCompactionPolicySupported(settings: Settings): void {
  if (
    cfgCompactionModelThresholdsEnabled.get(settings) &&
    Object.keys(cfgCompactionModelThresholds.get(settings)).length
  )
    throw new Error('RPC compaction does not yet support inherited per-model thresholds')
}
