/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createInterface } from 'node:readline'

const sessions = new Map()
const pendingHostRequests = new Map()
const model = {
  provider: 'phi-office-smoke',
  id: 'office-highlight-smoke',
  name: 'Office Highlight Smoke',
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
  credentials: [{ id: 'office-highlight-smoke', providerId: model.provider, type: 'runtime' }]
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

function fail(id, error) {
  send({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
}

function parseCommand(value) {
  const command = JSON.parse(value)
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('Office highlight smoke command must be an object')
  }
  if (!/^[a-z0-9-]{1,80}$/.test(command.id ?? '')) {
    throw new Error('Office highlight smoke command has an invalid id')
  }
  if (!command.apply || typeof command.apply !== 'object' || Array.isArray(command.apply)) {
    throw new Error('Office highlight smoke command is missing apply')
  }
  const delayMs = command.delayMs ?? 0
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5_000) {
    throw new Error('Office highlight smoke command has an invalid delay')
  }
  return { ...command, delayMs }
}

function requestHost(pending) {
  const id = `office-highlight-smoke-${pending.command.id}`
  pendingHostRequests.set(id, pending)
  send({
    type: 'hostRequest',
    id,
    method: 'office.apply',
    params: pending.command.apply,
    context: {
      originSessionId: pending.sessionId,
      agentRunId: pending.hostRunId,
      toolCallId: id
    }
  })
}

function completePrompt(pending) {
  const session = sessions.get(pending.sessionId)
  if (!session) return fail(pending.requestId, 'Office highlight smoke session disappeared')
  send({ id: pending.requestId, ok: true, result: sessionState(session) })
}

function handleHostResponse(message) {
  const pending = pendingHostRequests.get(message.id)
  if (!pending) return
  pendingHostRequests.delete(message.id)
  try {
    if (!message.ok) throw new Error(message.error || 'office.apply host request failed')
    const result = message.result
    if (!result || typeof result !== 'object' || result.ok !== true) {
      throw new Error(`office.apply rejected: ${JSON.stringify(result)}`)
    }
    completePrompt(pending)
  } catch (error) {
    fail(pending.requestId, error)
  }
}

function prompt(id, params) {
  const session = sessions.get(params.sessionId)
  if (!session) return fail(id, `Unknown session: ${String(params.sessionId)}`)
  try {
    const command = parseCommand(String(params.text ?? ''))
    const hostRunId = params.options?.hostRunId
    if (typeof hostRunId !== 'string' || hostRunId.length === 0) {
      throw new Error('Office highlight smoke prompt has no trusted host run id')
    }
    const pending = { requestId: id, sessionId: params.sessionId, hostRunId, command }
    if (command.delayMs > 0) setTimeout(() => requestHost(pending), command.delayMs)
    else requestHost(pending)
  } catch (error) {
    fail(id, error)
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
    const message = JSON.parse(line)
    if (message.type === 'hostResponse') handleHostResponse(message)
    else handleRequest(message)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  }
})
