/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { renameSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [snapshotPath, mode] = process.argv.slice(2)
const snapshot = {
  pid: process.pid,
  args: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  methods: []
}
function saveSnapshot() {
  const temporary = `${snapshotPath}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(snapshot))
  renameSync(temporary, snapshotPath)
}
saveSnapshot()
// Exercise the SDK's bounded SIGKILL escalation on failure and timeout.
if (mode !== 'success') process.on('SIGTERM', () => {})

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const request = JSON.parse(line)
  snapshot.methods.push(request.method)
  saveSnapshot()
  if (request.id === undefined) return
  if (request.method === 'initialize') {
    if (mode === 'timeout') return
    if (mode === 'init-error') {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'fixture initialize failure' } })}\n`
      )
      return
    }
    reply(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'phi-discovery-fixture', version: '1' }
    })
  } else if (request.method === 'tools/list') {
    if (mode === 'list-timeout') return
    if (mode === 'list-error') {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'fixture tool-list failure' } })}\n`
      )
      return
    }
    const secondPage = request.params?.cursor === 'second'
    reply(request.id, {
      tools: [
        { name: secondPage ? 'fixture_second' : 'fixture_first', inputSchema: { type: 'object' } }
      ],
      ...(secondPage ? {} : { nextCursor: 'second' })
    })
  }
})
input.on('close', () => {
  if (mode === 'success') process.exit(0)
})
if (mode !== 'success') setInterval(() => {}, 1000)

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
