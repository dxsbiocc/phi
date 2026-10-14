import { Settings } from '@oh-my-pi/pi-coding-agent'
import { createPhiSettings } from './settings'
import {
  listSearxngEngines,
  normalizeWebSearchSettingsPatch,
  WEB_SEARCH_PROVIDER_DETAILS,
  webSearchSettingsFromValues
} from '../../web-search-settings'
import { isRecord, stringValue } from './common'
import { getContext, webSearchAuthStatus } from './runtime-context'
import { sessions } from './state'

export async function handleWebSearchRequest(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'settings.webSearch.get': {
      const agentDir = isRecord(params)
        ? stringValue(params.agentDir, process.env.PI_CODING_AGENT_DIR)
        : stringValue(process.env.PI_CODING_AGENT_DIR)
      const settings = await Settings.loadReadOnly({ cwd: agentDir, agentDir })
      const { auth } = await getContext(agentDir)
      return webSearchSettingsFromValues(
        createPhiSettings(settings).webSearch.read(),
        webSearchAuthStatus(auth)
      )
    }
    case 'settings.webSearch.update': {
      const record = isRecord(params) ? params : {}
      const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
      const next = normalizeWebSearchSettingsPatch(record.patch)
      const settings = await Settings.init({ cwd: agentDir, agentDir })
      const phiSettings = createPhiSettings(settings)
      phiSettings.webSearch.write(next)
      await phiSettings.flush()
      // Search roles are session-scoped in OMP 18.10. Refresh current sessions
      // without discarding compaction or other runtime overrides.
      await Promise.all(
        [...sessions.values()]
          .filter((entry) => entry.agentDir === agentDir)
          .map((entry) => entry.result.session.settings.reloadFromDisk())
      )
      const persisted = await Settings.loadReadOnly({ cwd: agentDir, agentDir })
      const { auth } = await getContext(agentDir)
      return webSearchSettingsFromValues(
        createPhiSettings(persisted).webSearch.read(),
        webSearchAuthStatus(auth)
      )
    }
    case 'settings.webSearch.apiKey.set': {
      const record = isRecord(params) ? params : {}
      const providerId = record.providerId
      const detail =
        typeof providerId === 'string'
          ? WEB_SEARCH_PROVIDER_DETAILS[providerId as keyof typeof WEB_SEARCH_PROVIDER_DETAILS]
          : undefined
      if (!detail || !('apiKeyAuthId' in detail)) throw new Error('该搜索服务不接受 API Key')
      const key = record.key
      if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n]/.test(key)) {
        throw new Error('请输入有效的 API Key')
      }
      const { auth } = await getContext(record.agentDir)
      await auth.replaceApiKey(detail.apiKeyAuthId, key)
      return webSearchAuthStatus(auth)[providerId as keyof typeof WEB_SEARCH_PROVIDER_DETAILS]
    }
    case 'settings.webSearch.apiKey.clear': {
      const record = isRecord(params) ? params : {}
      const providerId = record.providerId
      const detail =
        typeof providerId === 'string'
          ? WEB_SEARCH_PROVIDER_DETAILS[providerId as keyof typeof WEB_SEARCH_PROVIDER_DETAILS]
          : undefined
      if (!detail || !('apiKeyAuthId' in detail)) throw new Error('该搜索服务没有 API Key')
      const { auth } = await getContext(record.agentDir)
      await auth.clearApiKeys(detail.apiKeyAuthId)
      return webSearchAuthStatus(auth)[providerId as keyof typeof WEB_SEARCH_PROVIDER_DETAILS]
    }
    case 'settings.webSearch.searxngEngines': {
      const agentDir = isRecord(params)
        ? stringValue(params.agentDir, process.env.PI_CODING_AGENT_DIR)
        : stringValue(process.env.PI_CODING_AGENT_DIR)
      const settings = await Settings.loadReadOnly({ cwd: agentDir, agentDir })
      return listSearxngEngines(createPhiSettings(settings).webSearch.readSearxngCredentials())
    }
    default:
      throw new Error(`Unknown OMP worker method: ${method}`)
  }
}
