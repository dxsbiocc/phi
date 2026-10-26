import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { PassThrough, type Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { KernelProtocolCore } from '../src/kernel/protocol'
import { StdioFrameTransport } from '../src/kernel/transports/stdio'
import {
  encodeFrame,
  parseFrame,
  PHI_KERNEL_PROTOCOL_VERSION,
  type JsonValue,
  type KernelRequestFrame,
  type KernelResponseFrame,
  type ParsedFrame
} from '../src/shared/kernel-protocol'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function request(
  id: string,
  method: string,
  generation: number,
  params: JsonValue,
  sessionId?: string
): KernelRequestFrame {
  return {
    kind: 'request',
    id,
    method,
    generation,
    params,
    ...(sessionId ? { sessionId } : {})
  }
}

function helloRequest(id = 'hello'): KernelRequestFrame {
  return request(id, 'kernel.hello', 0, {
    protocol: PHI_KERNEL_PROTOCOL_VERSION,
    client: { name: 'stdio-test', version: '1.0.0' }
  })
}

function createLineReader(input: Readable): {
  next(): Promise<string>
  received: string[]
} {
  const received: string[] = []
  const pending: Array<(line: string) => void> = []
  let buffer = ''
  let cursor = 0

  input.setEncoding('utf8')
  input.on('data', (chunk: string) => {
    buffer += chunk
    let delimiter = buffer.indexOf('\n')
    while (delimiter !== -1) {
      const line = buffer.slice(0, delimiter)
      buffer = buffer.slice(delimiter + 1)
      received.push(line)
      pending.shift()?.(line)
      delimiter = buffer.indexOf('\n')
    }
  })

  return {
    received,
    next() {
      const alreadyRead = received[cursor]
      if (alreadyRead !== undefined) {
        cursor += 1
        return Promise.resolve(alreadyRead)
      }
      return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for JSONL frame')),
          2_000
        )
        pending.push((line) => {
          clearTimeout(timeout)
          cursor += 1
          resolve(line)
        })
      })
    }
  }
}

function decodedResponse(line: string, id: string): KernelResponseFrame {
  const parsed = parseFrame(line)
  if (!('kind' in parsed)) assert.fail(`expected a frame, received ${parsed.code}`)
  assert.equal(parsed.kind, 'response')
  assert.equal(parsed.id, id)
  return parsed
}

function resultRecord(response: KernelResponseFrame): Record<string, JsonValue> {
  assert.equal(response.ok, true)
  assert.equal(typeof response.result, 'object')
  assert.ok(response.result !== null && !Array.isArray(response.result))
  return response.result as Record<string, JsonValue>
}

test('the protocol core runs unchanged over the stdio transport adapter', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const reader = createLineReader(output)
  const transport = new StdioFrameTransport(input, output)
  const core = new KernelProtocolCore({
    kernelVersion: 'test-kernel',
    ompVersion: 'test-omp',
    kernelInstanceId: 'stdio-contract-kernel',
    handlers: {
      'session.snapshot': (_params, _context, frame) => ({
        sessionId: frame.sessionId ?? 'missing',
        messages: [],
        cwd: '/tmp/stdio-contract'
      })
    }
  })
  core.attachTransport(transport, { trusted: true, connectionId: 'stdio-contract' })

  input.write(encodeFrame(helloRequest()))
  const greeting = decodedResponse(await reader.next(), 'hello')
  const greetingResult = resultRecord(greeting)
  assert.deepEqual(greetingResult.capabilities, ['session.snapshot'])
  assert.equal(greetingResult.controllerGeneration, 1)

  input.write(encodeFrame(request('snapshot', 'session.snapshot', 1, {}, 'session-over-stdio')))
  const snapshot = decodedResponse(await reader.next(), 'snapshot')
  assert.deepEqual(resultRecord(snapshot), {
    sessionId: 'session-over-stdio',
    messages: [],
    cwd: '/tmp/stdio-contract'
  })

  input.end()
  output.destroy()
})

test('the headless Bun entry negotiates, exposes worker capabilities, and exits on EOF', async () => {
  const child = spawn('bun', ['src/kernel/main.ts'], {
    cwd: repoRoot,
    env: { ...process.env, PI_CODING_AGENT_DIR: repoRoot },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const reader = createLineReader(child.stdout)
  let diagnostics = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    diagnostics += chunk
  })

  try {
    child.stdin.write(encodeFrame(helloRequest('entry-hello')))
    const greeting = decodedResponse(await reader.next(), 'entry-hello')
    const greetingResult = resultRecord(greeting)
    assert.deepEqual(greetingResult.protocol, PHI_KERNEL_PROTOCOL_VERSION)
    assert.deepEqual(greetingResult.capabilities, [
      'session.create',
      'session.open',
      'sessions.list',
      'session.prompt',
      'session.plan.enter',
      'session.plan.cancel',
      'planRuns.list',
      'planRuns.get',
      'planRuns.retryStep',
      'planRuns.skipStep',
      'planRuns.replan',
      'planRuns.stop',
      'agentRuns.start',
      'agentRuns.list',
      'agentRuns.wait',
      'agentRuns.steer',
      'agentRuns.stop',
      'resources.reload',
      'shellJobs.list',
      'shellJobs.cancel',
      'session.fork',
      'session.abort',
      'session.snapshot',
      'session.setModel',
      'session.setThinkingLevel',
      'session.contextUsage',
      'session.compact',
      'session.getAutoCompaction',
      'session.setAutoCompaction',
      'memory.read',
      'memory.deleteLesson',
      'memory.clear',
      'session.close',
      'models.catalog',
      'events.subscribe',
      'approval.respond'
    ])
    assert.equal(greetingResult.controllerGeneration, 1)
    assert.equal(greetingResult.lastSeq, 0)
    assert.deepEqual(greetingResult.kernel, { version: '0.1.0', ompVersion: '18.10.3' })

    const exitStarted = Date.now()
    child.stdin.end()
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Kernel did not exit after stdin closed')),
          2_000
        )
        child.once('exit', (exitCode, exitSignal) => {
          clearTimeout(timeout)
          resolve([exitCode, exitSignal])
        })
      }
    )
    assert.equal(code, 0)
    assert.equal(signal, null)
    assert.ok(Date.now() - exitStarted < 1_500)
    assert.equal(diagnostics, '')

    for (const line of reader.received) {
      const parsed = parseFrame(line)
      assert.ok('kind' in parsed)
      assert.equal((parsed as ParsedFrame).kind, 'response')
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})
