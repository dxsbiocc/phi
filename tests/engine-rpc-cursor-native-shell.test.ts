import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { createScopedCursorH2Gateway } from '../src/main/agent/engine/in-process/scoped-cursor-h2-gateway'
import { startCloudProvider } from './helpers/model-gateway-cloud-provider'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'

test(
  'actual remote OMP Cursor transport returns read and bash results to the provider',
  { timeout: 60_000 },
  async (t) => {
    const fixture = await runtimeCompositionFixture({ auditModelGatewayWire: false })
    const provider = await startCloudProvider()
    const token = randomBytes(32).toString('base64url')
    const scoped = await createScopedCursorH2Gateway({
      token,
      allowedModelIds: [
        'cursor-grok-4.6-fast',
        'cursor-grok-4.6-low-fast',
        'cursor-grok-4.6-medium-fast',
        'cursor-grok-4.6-high-fast',
        'cursor-grok-4.6-xhigh-fast'
      ],
      resolveBearer: async () => 'private-cursor-access-fixture',
      upstreamOrigin: await provider.bridge.ensure()
    })
    t.after(async () => {
      await fixture.close()
      await scoped.close()
      await provider.close()
    })
    const cwd = fixture.defaults.params.cwd
    await writeFile(join(cwd, '.phi-validation.txt'), 'ok\n')
    const ref = { provider: 'cursor', id: 'cursor-grok-4.6-fast' }
    const model = { ...ref, name: 'Grok 4.6 Fast', reasoning: true, supportsImages: false }
    const transport = {
      ...fixture.defaults.transport,
      models: [ref],
      gateway: {
        async createModelGatewayLease(params: { sessionId: string; generation: number }) {
          let resolveClosed!: () => void
          const closed = new Promise<void>((resolve) => {
            resolveClosed = resolve
          })
          return {
            leaseId: `lease-${params.generation}`,
            sessionId: params.sessionId,
            generation: params.generation,
            localPort: scoped.port,
            bearerToken: randomBytes(32).toString('base64url'),
            cursor: { localPort: scoped.port, bearerToken: token },
            models: [
              {
                provider: ref.provider,
                id: ref.id,
                name: model.name,
                reasoning: true,
                input: ['text' as const],
                contextWindow: 256000,
                maxTokens: 16384
              }
            ],
            closed,
            async close() {
              resolveClosed()
            }
          }
        }
      }
    }
    let approvalRequests = 0
    let allowApproval = true
    const runtime = await fixture.create({
      transport,
      params: { ...fixture.defaults.params, model, thinkingLevel: 'high' },
      action: { type: 'new', model: ref },
      approval: {
        shouldGate: () => true,
        requestToolApproval: () => {
          approvalRequests++
          return allowApproval ? 'approved' : 'denied'
        }
      }
    })
    provider.enqueue({ tool: true, toolName: 'read', toolPath: '.phi-validation.txt', text: 'ok' })
    const turn = await runtime.prompt(
      randomUUID(),
      'Read .phi-validation.txt and reply with its content.'
    )
    assert.equal(turn.outcome, 'completed')
    assert.match(JSON.stringify(turn.snapshot.messages), /ok/)
    const readRequest = provider.snapshot().requests.at(-1)
    assert.ok(readRequest?.body.mcpResultBase64)
    assert.ok(
      Buffer.from(String(readRequest.body.mcpResultBase64), 'base64').includes(Buffer.from('ok'))
    )
    provider.enqueue({ tool: true, toolName: 'bash', toolArgs: { command: 'pwd' }, text: 'done' })
    const shellTurn = await runtime.prompt(randomUUID(), 'Run pwd with bash and report the output.')
    assert.equal(shellTurn.outcome, 'completed')
    assert.match(JSON.stringify(shellTurn.snapshot.messages), /done/)
    const shellRequest = provider.snapshot().requests.at(-1)
    assert.ok(shellRequest?.body.mcpResultBase64)
    assert.ok(
      Buffer.from(String(shellRequest.body.mcpResultBase64), 'base64').includes(
        Buffer.from(basename(cwd))
      )
    )
    assert.ok(
      shellTurn.snapshot.messages.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'toolName' in message &&
          message.toolName === 'bash' &&
          'isError' in message &&
          message.isError === false
      )
    )
    assert.ok(approvalRequests > 0)
    const approvedCount = approvalRequests
    allowApproval = false
    provider.enqueue({
      tool: true,
      toolName: 'bash',
      toolArgs: { command: 'printf blocked > .phi-denied.txt' },
      text: 'denied'
    })
    await runtime.prompt(randomUUID(), 'Run the requested shell command.').catch(() => undefined)
    assert.ok(approvalRequests > approvedCount)
    assert.equal(
      await access(join(cwd, '.phi-denied.txt')).then(
        () => true,
        () => false
      ),
      false
    )
  }
)
