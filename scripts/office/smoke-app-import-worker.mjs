/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createInterface } from 'node:readline'

const sessions = new Map()
const model = {
  provider: 'phi-office-smoke',
  id: 'office-import-smoke',
  name: 'Office Import Smoke',
  reasoning: false,
  supportsImages: false
}
const snapshot = {
  providers: [
    {
      id: model.provider,
      name: 'Phi Office Smoke',
      auth: { apiKey: false, oauth: false },
      status: { configured: true, source: 'runtime', label: 'isolated smoke worker' }
    }
  ],
  models: [model],
  credentials: [{ id: 'office-import-smoke', providerId: model.provider, type: 'runtime' }]
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function sessionState(session) {
  return {
    messages: [],
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    cwd: session.cwd
  }
}

function createSession(id, params) {
  const session = {
    cwd: params.cwd,
    model: params.model ?? model,
    thinkingLevel: params.thinkingLevel
  }
  sessions.set(params.sessionId, session)
  send({ id, ok: true, result: { sessionId: params.sessionId, state: sessionState(session) } })
}

function prompt(id, params) {
  const session = sessions.get(params.sessionId)
  if (!session) {
    send({ id, ok: false, error: `Unknown session: ${String(params.sessionId)}` })
    return
  }
  if (String(params.text ?? '') !== 'O23-import-smoke-session') {
    send({ id, ok: false, error: 'Unexpected Office import smoke prompt' })
    return
  }
  send({ id, ok: true, result: sessionState(session) })
}

function handleRequest(message) {
  const { id, method, params = {} } = message
  if (method === 'modelRuntime.snapshot') return send({ id, ok: true, result: snapshot })
  if (method === 'resources.reload') {
    return send({ id, ok: true, result: { skills: { skills: [], diagnostics: [] } } })
  }
  if (method === 'settings.autoCompactionDefaults') {
    return send({ id, ok: true, result: { enabled: false, thresholdPercent: 80 } })
  }
  if (method === 'settings.nextActionSuggestionsEnabled') {
    return send({ id, ok: true, result: false })
  }
  if (method === 'sessions.list' || method === 'plugins.list') {
    return send({ id, ok: true, result: [] })
  }
  if (method === 'session.create') return createSession(id, params)
  if (method === 'session.prompt') return prompt(id, params)
  if (method === 'session.dispose') sessions.delete(params.sessionId)
  if (method === 'session.setModel' && sessions.has(params.sessionId)) {
    sessions.get(params.sessionId).model = params.model
  }
  if (method === 'session.setThinkingLevel' && sessions.has(params.sessionId)) {
    sessions.get(params.sessionId).thinkingLevel = params.level
  }
  const session = sessions.get(params.sessionId)
  const result = method.startsWith('session.') && session ? sessionState(session) : null
  send({ id, ok: true, result })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    handleRequest(JSON.parse(line))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  }
})
