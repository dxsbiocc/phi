import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { RpcExecutionAuthority } from '../src/main/agent/engine/rpc/execution-authority'
import {
  RpcApprovalBridge,
  type RpcApprovalDecision
} from '../src/main/agent/engine/rpc/approval-bridge'
import { rpcToolCallId } from '../src/main/agent/engine/rpc/control-frame'
import { createApprovalEnvelope } from '../src/main/agent/engine/phi-extension/lib/rpc-approval-protocol'
import { executionFixture, executionUntil } from './helpers/rpcExecutionAuthorityFixture'
import { deferred } from './helpers/rpc-initialization-wire'

const CURSOR_ID =
  'call-729aca6f-9070-4860-991b-9d2ea623e3fb-7\nfc_p5iUnQT-2byqsH-1c5eb5d0-aws_uw2_0'
const LONG_ID = `call-${'x'.repeat(300)}\nfc_${'y'.repeat(300)}`

test('tool-call id validator admits provider ids but still rejects empty, oversized and ill-formed', () => {
  assert.equal(rpcToolCallId(CURSOR_ID), true)
  assert.equal(rpcToolCallId(LONG_ID), true)
  assert.equal(rpcToolCallId(''), false)
  assert.equal(rpcToolCallId('a'.repeat(1025)), false)
  assert.equal(rpcToolCallId('\ud800'), false)
  assert.equal(rpcToolCallId(7), false)
})

for (const [label, id] of [
  ['newline-bearing Cursor id', CURSOR_ID],
  ['id longer than 128 characters', LONG_ID]
] as const)
  test(
    `actual bash call with ${label} is admitted, bound to its origin and approved`,
    { timeout: 30000 },
    async (t) => {
      const f = await executionFixture()
      t.after(() => f.close())
      const authority = await RpcExecutionAuthority.create({
        connection: f.connection,
        identity: f.identity,
        capability: f.capability,
        roster: f.roster
      })
      t.after(() => authority.dispose())
      const answer = deferred<RpcApprovalDecision>()
      let requested = 0
      const approval = new RpcApprovalBridge({
        connection: f.connection,
        scope: { ...authority.sessionIdentity(), currentRun: () => authority.currentRun() },
        shouldGate: () => true,
        requestToolApproval: () => answer.promise,
        onEvent: (event) => {
          if (event.type === 'approval_requested') requested++
        }
      })
      t.after(() => approval.dispose())
      const run = await authority.beginRun('id-run')
      const args = { command: 'printf after > effect.txt' }
      f.provider.enqueue({ tool: { name: 'bash', args, id } }, { text: 'done' })
      const prompt = authority.prompt('Perform the requested operation once.')
      await executionUntil(() => requested === 1)
      const digest = createApprovalEnvelope(
        { ...authority.sessionIdentity(), runId: run.id },
        id,
        'bash',
        args
      ).inputDigest
      const signal = new AbortController().signal
      assert.equal(run.authorizeCall(id, 'bash', args, digest, signal), 'main')
      // A different or truncated id cannot borrow this origin.
      assert.equal(run.authorizeCall(id.slice(0, -1), 'bash', args, digest, signal), undefined)
      assert.equal(run.authorizeCall(`${id}x`, 'bash', args, digest, signal), undefined)
      assert.equal(existsSync(join(f.cwd, 'effect.txt')), false)
      answer.resolve('approved')
      assert.equal((await prompt).status, 'completed', f.stderr())
      assert.equal(readFileSync(join(f.cwd, 'effect.txt'), 'utf8'), 'after')
    }
  )
