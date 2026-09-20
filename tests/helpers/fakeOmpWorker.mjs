// A stand-in for omp-sdk-worker.ts: speaks the bridge's JSON-lines protocol, keeps its
// sessions in memory like the real worker, and can be told to exit (method `crash`).
import { createInterface } from 'node:readline'

const sessions = new Map()
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params = {} } = JSON.parse(line)
  const ok = (result) => send({ id, ok: true, result })
  const fail = (error) => send({ id, ok: false, error })
  const known = () => sessions.has(params.sessionId)

  switch (method) {
    case 'session.create':
      sessions.set(params.sessionId, { manager: params.sessionManager, model: params.model })
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
    case 'crash':
      process.stderr.write('fake worker crashed\n')
      return process.exit(3)
    default:
      return ok(null)
  }
})
