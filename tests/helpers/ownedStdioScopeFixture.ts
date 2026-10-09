import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectToServer, disconnectServer } from '@oh-my-pi/pi-coding-agent/mcp/client'
import { StdioTransport } from '@oh-my-pi/pi-coding-agent/mcp/transports/stdio'
import { OwnedStdioTransportScope } from '../../src/main/agent/omp/owned-stdio-transports'

const [root, node, server] = process.argv.slice(2)
function config(name: string): { type: 'stdio'; command: string; args: string[]; timeout: number } {
  return {
    type: 'stdio',
    command: node,
    args: [server, join(root, `${name}.json`), 'success'],
    timeout: 5000
  }
}
function alive(name: string): boolean {
  const record = JSON.parse(readFileSync(join(root, `${name}.json`), 'utf8')) as { pid: number }
  try {
    process.kill(record.pid, 0)
    return true
  } catch {
    return false
  }
}

const first = new OwnedStdioTransportScope()
const second = new OwnedStdioTransportScope()
const unowned = new StdioTransport(config('unowned'))
await unowned.connect()
assert.equal(unowned.close, StdioTransport.prototype.close, 'unowned close must remain unchanged')
const [a, b] = await Promise.all([
  first.run(() => connectToServer('first', config('first'))),
  second.run(() => connectToServer('second', config('second')))
])
await Promise.all([disconnectServer(a), first.drain(), first.drain()])
assert.equal(alive('first'), false)
assert.equal(alive('second'), true)
assert.equal(alive('unowned'), true)
await disconnectServer(b)
await second.drain()
await unowned.close()

const cancelled = new OwnedStdioTransportScope()
const pending = cancelled.run(() => connectToServer('cancelled', config('cancelled')))
void pending.catch(() => undefined)
await cancelled.drain()
await assert.rejects(pending, /closing|not connected/i)
if (existsSync(join(root, 'cancelled.json'))) assert.equal(alive('cancelled'), false)
await assert.rejects(
  cancelled.run(() => connectToServer('late', config('late'))),
  /closing/
)
assert.equal(existsSync(join(root, 'late.json')), false)
const unsupportedScope = new OwnedStdioTransportScope()
const currentConnect = StdioTransport.prototype.connect
StdioTransport.prototype.connect = async () => undefined
assert.throws(
  () => unsupportedScope.run(() => connectToServer('unsupported', config('unsupported'))),
  /Unsupported MCP SDK/
)
StdioTransport.prototype.connect = currentConnect
assert.equal(existsSync(join(root, 'unsupported.json')), false)
process.stdout.write(
  JSON.stringify({ isolated: true, concurrentCloseAwaited: true, lateSpawnPrevented: true })
)
