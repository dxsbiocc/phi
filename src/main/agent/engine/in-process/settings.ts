import { Settings } from '@oh-my-pi/pi-coding-agent'
import { DEFAULT_COMPACTION_METHOD_ORDER, resolveCompactionMethodOrder } from '../omp-internals'

import type { PhiCompactionSettings, PhiSettings } from '../types'

const autoCompactionBaselines = new WeakMap<Settings, PhiCompactionSettings>()

function readRawCompactionSettings(settings: Settings): PhiCompactionSettings {
  return {
    enabled: settings.get('compaction.enabled'),
    thresholdPercent: settings.get('compaction.thresholdPercent'),
    thresholdTokens: settings.get('compaction.thresholdTokens'),
    methodOrder: [...settings.get('compaction.methodOrder')]
  }
}

export function createPhiSettings(settings: Settings): PhiSettings {
  return {
    compaction: {
      read: () => {
        const values = readRawCompactionSettings(settings)
        return {
          ...values,
          methodOrder: resolveCompactionMethodOrder(values.methodOrder)
        }
      },
      override: (values) => {
        settings.override('compaction.enabled', values.enabled)
        settings.override('compaction.thresholdPercent', values.thresholdPercent)
        settings.override('compaction.thresholdTokens', values.thresholdTokens)
        settings.override('compaction.methodOrder', [...values.methodOrder])
      }
    },
    webSearch: {
      read: () => ({
        order: [...settings.get('providers.webSearchOrder')],
        excluded: [...settings.get('providers.webSearchExclude')],
        endpoint: settings.get('searxng.endpoint'),
        engines: settings.get('searxng.engines')
      }),
      write: (values) => {
        settings.set('providers.webSearchOrder', [...values.order])
        settings.set('providers.webSearchExclude', [...values.excluded])
        settings.set('searxng.endpoint', values.endpoint)
        settings.set('searxng.engines', values.engines)
      },
      readSearxngCredentials: () => ({
        endpoint: settings.get('searxng.endpoint'),
        token: settings.get('searxng.token'),
        basicUsername: settings.get('searxng.basicUsername'),
        basicPassword: settings.get('searxng.basicPassword')
      })
    },
    mcp: {
      read: () => ({
        enableProjectConfig: settings.get('mcp.enableProjectConfig') ?? true,
        notifications: settings.get('mcp.notifications')
      })
    },
    extensions: {
      read: () => ({
        configured: [...(settings.get('extensions') ?? [])],
        sourceLevel: settings.extensionsSourceLevel()
      })
    },
    memory: {
      useLocalBackend: () => settings.override('memory.backend', 'local')
    },
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
