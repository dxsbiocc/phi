/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [snapshotPath, schemaPath] = process.argv.slice(2)
const snapshot = { pid: process.pid, methods: [], calls: [] }

function save() {
  const temporary = `${snapshotPath}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(snapshot))
  renameSync(temporary, snapshotPath)
}

function schema() {
  return JSON.parse(readFileSync(schemaPath, 'utf8'))
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function notifyToolsChanged() {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`
  )
}

save()
process.on('SIGUSR1', notifyToolsChanged)
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const request = JSON.parse(line)
  snapshot.methods.push(request.method)
  if (request.method === 'tools/call') {
    snapshot.calls.push({ name: request.params?.name, arguments: request.params?.arguments })
  }
  save()
  if (request.id === undefined) return
  if (request.method === 'initialize') {
    reply(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'phi-kernel-a13-fixture', version: '1' }
    })
    return
  }
  if (request.method === 'tools/list') {
    const current = schema()
    reply(request.id, {
      tools: [
        {
          name: current.toolName,
          description: `A13 ${current.toolName}`,
          inputSchema: { type: 'object', properties: { value: { type: 'string' } } }
        }
      ]
    })
    return
  }
  if (request.method === 'tools/call') {
    reply(request.id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            tool: request.params?.name,
            value: request.params?.arguments?.value,
            marker: process.env.MCP_SESSION_MARKER
          })
        }
      ]
    })
  }
})
input.on('close', () => process.exit(0))
