import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'

type WorkerMessage = {
  type?: string
  event?: string
  sessionId?: string
  payload?: {
    requestId?: string
    toolCallId?: string
    toolName?: string
    agentRunId?: string
  }
  handlers?: boolean
  sideEffectsBlocked?: boolean
  remoteUrlBlocked?: boolean
  disposed?: boolean
}

test('restricted specialist sessions install real approval and URL guards on the live runner', async () => {
  const child = spawn(
    'bun',
    [join(process.cwd(), 'tests', 'helpers', 'specialistToolApprovalSmoke.ts')],
    {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  const approvals: Array<{ toolName?: string; toolCallId?: string }> = []
  let summary: WorkerMessage | undefined
  let stdoutBuffer = ''
  let stderr = ''

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      const message = JSON.parse(line) as WorkerMessage
      if (message.type === 'event' && message.event === 'toolApproval') {
        assert.equal(message.sessionId, 'parent-session')
        assert.equal(message.payload?.agentRunId, 'specialist-run')
        assert.ok(message.payload?.requestId)
        approvals.push({
          toolName: message.payload.toolName,
          toolCallId: message.payload.toolCallId
        })
        child.stdin.write(
          `${JSON.stringify({
            id: `deny-${approvals.length}`,
            method: 'toolApproval.result',
            params: {
              requestId: message.payload.requestId,
              result: { block: true, reason: 'specialist approval denied' }
            }
          })}\n`
        )
      } else if (message.handlers === true) {
        summary = message
      }
    }
  })

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`specialist approval smoke timed out: ${stderr}`))
      }, 30_000)
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timeout)
        resolve({ code, signal })
      })
    }
  )

  assert.deepEqual(exit, { code: 0, signal: null }, stderr)
  assert.deepEqual(approvals, [
    { toolName: 'bash', toolCallId: 'bash-call' },
    { toolName: 'write', toolCallId: 'write-call' },
    { toolName: 'edit', toolCallId: 'edit-call' }
  ])
  assert.deepEqual(summary, {
    handlers: true,
    sideEffectsBlocked: true,
    remoteUrlBlocked: true,
    disposed: true
  })
})
