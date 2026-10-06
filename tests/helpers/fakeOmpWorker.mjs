/* eslint-disable @typescript-eslint/explicit-function-return-type */
// A stand-in for omp-sdk-worker.ts: speaks the bridge's JSON-lines protocol, keeps its
// sessions in memory like the real worker, and can be told to exit (method `crash`).
import { createInterface } from 'node:readline'

const sessions = new Map()
const pendingHostRequests = new Map()
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'hostResponse') {
    const requestId = pendingHostRequests.get(message.id)
    if (!requestId) return
    pendingHostRequests.delete(message.id)
    return send(
      message.ok
        ? { id: requestId, ok: true, result: message.result }
        : { id: requestId, ok: false, error: message.error }
    )
  }
  const { id, method, params = {} } = message
  const ok = (result) => send({ id, ok: true, result })
  const fail = (error) => send({ id, ok: false, error })
  const known = () => sessions.has(params.sessionId)

  switch (method) {
    case 'session.create':
      sessions.set(params.sessionId, {
        manager: params.sessionManager,
        model: params.model,
        officeEnabled: params.officeEnabled
      })
      return ok({
        sessionId: params.sessionId,
        state: { sessionFile: params.sessionManager?.path }
      })
    case 'session.prompt':
      if (!known()) return fail(`Unknown session: ${params.sessionId}`)
      return ok({ sessionFile: sessions.get(params.sessionId).manager?.path })
    case 'session.dispose':
      if (!known()) return fail(`Unknown session: ${params.sessionId}`)
      sessions.delete(params.sessionId)
      return ok(null)
    case 'inspect':
      return ok({ pid: process.pid, sessions: Object.fromEntries(sessions) })
    case 'test.hostRequest': {
      const hostRequestId = `host-${id}`
      pendingHostRequests.set(hostRequestId, id)
      return send({
        type: 'hostRequest',
        id: hostRequestId,
        method: params.method,
        params: params.hostParams,
        context: params.context
      })
    }
    case 'crash':
      process.stderr.write('fake worker crashed\n')
      return process.exit(3)
    default:
      return ok(null)
  }
})
