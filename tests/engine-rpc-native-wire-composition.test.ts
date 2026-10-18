import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readFile,
  readdir,
  access,
  mkdtemp,
  copyFile,
  chmod,
  writeFile,
  rm
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PhiTool } from '../src/main/agent/engine/types'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'
import {
  readGatewayJson,
  validateGatewayPayload
} from '../src/main/agent/engine/in-process/model-gateway-request'
import {
  NATIVE_OPTION_WIRE_KEYS,
  NATIVE_TOOL_WIRE_KEYS
} from '../src/main/agent/engine/phi-extension/lib/rpc-native-wire'

function hostRoster(calls: unknown[]): PhiTool[] {
  return Array.from({ length: 20 }, (_, toolIndex) => ({
    name: `wire_host_${toolIndex}`,
    label: `Synthetic wire host ${toolIndex}`,
    description: `Curated synthetic desktop tool ${toolIndex}`,
    site: 'host' as const,
    strict: true,
    approval: toolIndex === 0 ? ('write' as const) : ('read' as const),
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `field_${index}`,
          {
            type: 'string',
            description: `Keep this complete ordinary field ${index} on tool ${toolIndex}`
          }
        ])
      ),
      additionalProperties: false
    },
    async execute(id, args, _update, ctx, signal) {
      assert.equal(signal?.aborted, false)
      calls.push({ id, args, cwd: ctx.cwd })
      return { content: [{ type: 'text', text: 'actual desktop host execution result' }] }
    }
  }))
}

test(
  'production CLI with native tools and a larger advertised host schema roster sends only DTOs and executes approved tools',
  { timeout: 90000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    const calls: unknown[] = [],
      approvals: string[] = []
    const tools = hostRoster(calls)
    const runtime = await f.create({
      tools,
      approval: {
        shouldGate: () => true,
        requestToolApproval: async (request) => {
          if (request.toolName === tools[0].name)
            assert.equal(calls.length, 0, 'Host effect must wait for actual UI decision')
          if (request.toolName === 'write')
            await assert.rejects(access(join(f.f.scope.projectRoot, 'wire-approved.txt')), {
              code: 'ENOENT'
            })
          approvals.push(request.toolName)
          return 'approved' as const
        }
      }
    })
    assert.equal(runtime.isReady, true)
    await f.sdk.enqueue(
      {
        tool: {
          id: 'wire-native-write',
          name: 'write',
          args: { path: 'wire-approved.txt', content: 'approved actual native file' }
        }
      },
      {
        tool: {
          id: 'wire-desktop-host',
          name: tools[0].name,
          args: { field_0: 'kept schema value' }
        }
      },
      { text: 'large roster complete' }
    )
    const turn = await runtime.prompt(
      'wire-dto-run-1',
      'Write the ordinary fixture then use the desktop tool'
    )
    assert.equal(turn.result.status, 'completed', JSON.stringify(turn.result))
    assert.equal(
      await readFile(join(f.f.scope.projectRoot, 'wire-approved.txt'), 'utf8'),
      'approved actual native file'
    )
    assert.equal(calls.length, 1)
    assert.ok(approvals.includes('write'))
    assert.ok(approvals.includes(tools[0].name))
    const homes = await readdir(join(f.f.runtimeRoot, 'rpc-sessions'))
    const config = JSON.parse(
      await readFile(join(f.f.runtimeRoot, 'rpc-sessions', homes[0], 'runtime.json'), 'utf8')
    )
    const knownSecrets = [
      config.execution.capability,
      config.result.capability,
      config.nonce,
      ...f.leases.map((lease) => lease.bearerToken)
    ] as string[]
    assert.ok(f.wire.length >= 3)
    for (const raw of f.wire) {
      const json = JSON.stringify(raw)
      for (const secret of knownSecrets) assert.equal(json.includes(secret), false)
      const parsed = await readGatewayJson(
        new Request('http://127.0.0.1/v1/pi/stream', { method: 'POST', body: json }),
        new AbortController().signal
      )
      validateGatewayPayload(parsed, 'synthetic-lease')
      const value = parsed as {
        context: { tools: Array<Record<string, unknown>> }
        options: Record<string, unknown>
      }
      assert.deepEqual(
        value.context.tools.map((tool) => tool.name).sort(),
        ['read', 'write', 'edit', 'bash', 'glob', 'grep', ...tools.map((tool) => tool.name)].sort()
      )
      for (const actual of value.context.tools) {
        assert.ok(
          Object.keys(actual).every((key) => NATIVE_TOOL_WIRE_KEYS.includes(key)),
          JSON.stringify({ name: actual.name, keys: Object.keys(actual) })
        )
        const host = tools.find((tool) => tool.name === actual.name)
        if (host) {
          // The actual AgentLoop injects its declared intent field before the
          // native client. Preserve that full schema too; never disable tracing.
          const parameters = actual.parameters as Record<string, unknown>
          assert.deepEqual(parameters, {
            ...host.parameters,
            properties: {
              i: { type: 'string', description: 'concise intent' },
              ...(host.parameters.properties as Record<string, unknown>)
            },
            required: ['i']
          })
        }
      }
      assert.ok(
        Object.keys(value.options).every((key) =>
          (NATIVE_OPTION_WIRE_KEYS as readonly string[]).includes(key)
        )
      )
      assert.equal(value.options.speculativeToolExecution, undefined)
    }
    await f.sdk.enqueue({ text: 'next explicit turn retained native and host history' })
    assert.equal(
      (await runtime.prompt('wire-dto-run-2', 'Continue with the exact results')).result.status,
      'completed'
    )
    const requests = (await f.sdk.snapshot()).providerRequests
    const last = requests.at(-1)?.body as { messages?: Array<Record<string, unknown>> } | undefined
    const lastWire = f.wire.at(-1) as { context: { messages: Array<Record<string, unknown>> } }
    const canonicalResults = lastWire.context.messages.filter(
      (message) => message.role === 'toolResult'
    )
    assert.deepEqual(
      last?.messages
        ?.filter((message) => message.role === 'tool')
        .map((message) => ({ id: message.tool_call_id, content: message.content })),
      canonicalResults.map((message) => ({
        id: message.toolCallId,
        content: (message.content as Array<{ text: string }>).map((block) => block.text).join('\n')
      })),
      'Actual provider tool history must match the exact SDK canonical results, including legitimate archive references'
    )
    assert.ok(
      canonicalResults.some(
        (message) => message.toolCallId === 'wire-desktop-host' && message.isError === false
      )
    )
    // SDK shake rewrites the journal and stores original content in its known
    // sibling artifact directory. Verify actual durable source, not a forced
    // unpruned provider view or a natural-language URI crawl.
    const artifactDirectory = turn.snapshot.checkpoint.journalPath.replace(/\.jsonl$/u, '')
    const artifactNames = (await readdir(artifactDirectory)).filter((name) =>
      /^[0-9]+\.shake\.log$/u.test(name)
    )
    assert.ok(artifactNames.length > 0)
    const archived = (
      await Promise.all(
        artifactNames.map((name) => readFile(join(artifactDirectory, name), 'utf8'))
      )
    ).join('\n')
    assert.ok(archived.includes('actual desktop host execution result'))
    if (process.env.PHI_WIRE_SAVE_SHAKE_EVIDENCE === '1') {
      const evidence = await mkdtemp(join(tmpdir(), 'phi-wire-shake-evidence-'))
      t.after(() => rm(evidence, { recursive: true, force: true }))
      await copyFile(turn.snapshot.checkpoint.journalPath, join(evidence, 'journal.jsonl'))
      await chmod(join(evidence, 'journal.jsonl'), 0o600)
      for (const name of artifactNames) {
        await copyFile(join(artifactDirectory, name), join(evidence, name))
        await chmod(join(evidence, name), 0o600)
      }
      await writeFile(
        join(evidence, 'evidence.json'),
        JSON.stringify({
          evidence,
          originalJournal: turn.snapshot.checkpoint.journalPath,
          originalArtifacts: artifactDirectory
        }) + '\n',
        { mode: 0o600 }
      )
      t.diagnostic(`Synthetic exact journal/artifact evidence saved at ${evidence}`)
    }
    assert.equal(calls.length, 1, 'No replay of approved host execution')
  }
)
