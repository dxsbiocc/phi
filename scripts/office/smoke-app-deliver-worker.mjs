/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createInterface } from 'node:readline'

const sessions = new Map()
const pendingHostRequests = new Map()
const model = {
  provider: 'phi-office-smoke',
  id: 'office-delivery-smoke',
  name: 'Office Delivery Smoke',
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
  credentials: [{ id: 'office-smoke', providerId: model.provider, type: 'runtime' }]
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
    throw new Error('Office delivery smoke command must be an object')
  }
  if (!/^[a-z0-9-]{1,80}$/.test(command.id ?? '')) {
    throw new Error('Office delivery smoke command has an invalid id')
  }
  if (typeof command.outputName !== 'string' || command.outputName.length === 0) {
    throw new Error('Office delivery smoke command is missing outputName')
  }
  if (command.apply !== undefined && (!command.apply || typeof command.apply !== 'object')) {
    throw new Error('Office delivery smoke command has an invalid apply request')
  }
  return command
}

function requestHost(pending, method, params, suffix) {
  const id = `office-delivery-smoke-${pending.command.id}-${suffix}`
  pendingHostRequests.set(id, { ...pending, step: suffix })
  send({
    type: 'hostRequest',
    id,
    method,
    params,
    context: {
      originSessionId: pending.sessionId,
      agentRunId: pending.hostRunId,
      toolCallId: id
    }
  })
}

function completePrompt(pending) {
  const session = sessions.get(pending.sessionId)
  if (!session) return fail(pending.requestId, 'Office delivery smoke session disappeared')
  send({ id: pending.requestId, ok: true, result: sessionState(session) })
}

function requireHostSuccess(message, pending) {
  if (!message.ok) throw new Error(message.error || `${pending.step} host request failed`)
  const result = message.result
  if (!result || typeof result !== 'object' || result.ok !== true) {
    throw new Error(`${pending.step} rejected: ${JSON.stringify(result)}`)
  }
}

function handleHostResponse(message) {
  const pending = pendingHostRequests.get(message.id)
  if (!pending) return
  pendingHostRequests.delete(message.id)
  try {
    requireHostSuccess(message, pending)
    if (pending.step === 'apply') {
      requestHost(pending, 'office.deliver', { outputName: pending.command.outputName }, 'deliver')
      return
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
      throw new Error('Office delivery smoke prompt has no trusted host run id')
    }
    const pending = { requestId: id, sessionId: params.sessionId, hostRunId, command }
    if (command.apply) {
      requestHost(pending, 'office.apply', command.apply, 'apply')
    } else {
      requestHost(pending, 'office.deliver', { outputName: command.outputName }, 'deliver')
    }
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
  // Host-side list handlers call `.map` on these results, so an empty list is the correct stub.
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
