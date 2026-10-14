import {
  Settings,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager
} from '@oh-my-pi/pi-coding-agent'
import { runSearchQuery, webSearchCustomTool } from '@oh-my-pi/pi-coding-agent/web/search'
import { toolWireSchema } from '@oh-my-pi/pi-ai/utils/schema'
import { logger, postmortem, setProjectDir, getConfigRootDir } from '@oh-my-pi/pi-utils'
import { join } from 'node:path'
import { createPhiAuth } from '../../src/main/agent/engine/in-process/auth'
logger.setTransports({ file: false, console: false })
const [mode, agentDir, cwd, argument] = process.argv.slice(2)
setProjectDir(cwd)
const settings = await Settings.init({ cwd, agentDir })
settings.stopWatching()
const auth = await discoverAuthStorage(agentDir, { settings, cwd })
try {
  let result: unknown
  if (mode === 'snapshot') {
    result = {
      snapshot: auth.credentials.snapshot(),
      tokenPath: join(getConfigRootDir(), 'auth-broker.token')
    }
  } else if (mode === 'login-key') {
    await createPhiAuth(auth).setApiKey('brave', argument)
    result = true
  } else if (mode === 'key') {
    const api = createPhiAuth(auth)
    if (argument) await api.replaceApiKey('brave', argument)
    else await api.clearApiKeys('brave')
    result = true
  } else if (mode === 'search-models') {
    const registry = new ModelRegistry(auth, join(agentDir, 'models.yml'), { settings })
    await registry.refresh('offline')
    result = registry
      .getAll()
      .filter((model) => model.provider === 'openai' && model.webSearch === 'openai')
      .map((model) => ({ provider: model.provider, id: model.id }))
  } else if (mode === 'metadata') {
    result = {
      name: webSearchCustomTool.name,
      label: webSearchCustomTool.label,
      description: webSearchCustomTool.description,
      parameters: toolWireSchema(webSearchCustomTool)
    }
  } else {
    const models = new ModelRegistry(auth, join(agentDir, 'models.yml'), { settings })
    await models.refresh('offline')
    await models.hydrateCredentialScopedModelCaches()
    const searched = await runSearchQuery(JSON.parse(argument), {
      authStorage: auth,
      modelRegistry: models,
      sessionId: 'baseline'
    })
    result = searched
    if (mode === 'search-persist') {
      const manager = SessionManager.create(cwd, join(agentDir, 'baseline-sessions'))
      manager.appendMessage({
        role: 'toolResult',
        toolCallId: 'baseline-search',
        toolName: 'web_search',
        ...searched,
        isError: false,
        timestamp: 0
      })
      await manager.ensureOnDisk()
      const file = manager.getSessionFile()!
      await manager.close()
      const reopened = await SessionManager.open(file)
      const entry = reopened
        .getEntries()
        .find((entry) => entry.type === 'message' && entry.message.role === 'toolResult')
      if (!entry || entry.type !== 'message' || entry.message.role !== 'toolResult')
        throw new Error('Native persisted search result missing')
      result = {
        content: entry.message.content,
        details: entry.message.details,
        isError: entry.message.isError
      }
      await reopened.close()
    }
  }
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(result) + '\n', (error) =>
      error ? reject(error) : resolve()
    )
  )
} finally {
  settings.cancelPendingSaves()
  auth.close()
  await postmortem.quit(0)
}
