/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
const active = new Set()
const revoked = []
let count = 0
const respond = (id, result) =>
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'modelGateway.create') {
    const leaseId = `lease-${++count}`
    const complete = () => {
      active.add(leaseId)
      respond(id, {
        leaseId,
        sessionId: params.sessionId,
        generation: params.generation,
        localPort: 31000 + count,
        bearerToken: randomBytes(32).toString('base64url'),
        models: params.models.map((model) => ({
          ...model,
          name: 'Fixture model',
          reasoning: true,
          input: ['text'],
          contextWindow: 10000,
          maxTokens: 1000,
          baseUrl: 'SECRET_BASE',
          headers: { Authorization: 'SECRET_KEY' }
        })),
        credentials: 'SECRET_CREDENTIALS'
      })
    }
    if (params.sessionId === 'never-completes') return
    if (params.sessionId.startsWith('slow')) setTimeout(complete, 120)
    else complete()
  } else if (method === 'modelGateway.revoke') {
    active.delete(params.leaseId)
    revoked.push(params.leaseId)
    respond(id)
  } else if (method === 'inspect') respond(id, { pid: process.pid, active: [...active], revoked })
  else if (method === 'crash') process.exit(3)
  else if (method === 'session.create') respond(id, { sessionId: params.sessionId })
  else respond(id, {})
})
