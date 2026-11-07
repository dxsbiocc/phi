import { readFileSync } from 'node:fs'
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import { DEFAULT_SHAKE_CONFIG } from '@oh-my-pi/pi-agent-core/compaction'
import { registerRpcSessionVerification } from '../../src/main/agent/engine/phi-extension/extensions/rpc-session-verification'
import type { SessionVerificationIdentity } from '../../src/main/agent/engine/phi-extension/lib/rpc-session-verification-protocol'

/** Actual SDK default shake producer; no marker text or artifact body is written by this fixture. */
export default function fixture(pi: ExtensionAPI): void {
  const identity = JSON.parse(
    readFileSync(process.env.PHI_VERIFIER_FIXTURE!, 'utf8')
  ) as SessionVerificationIdentity
  const controller = new AbortController()
  registerRpcSessionVerification(pi, {
    ...identity,
    signal: controller.signal,
    assertActive: () => controller.signal.throwIfAborted()
  })
  let providerCalls = 0,
    created = false
  pi.on('before_provider_request', () => {
    providerCalls++
    throw new Error('Shake oracle must not invoke provider')
  })
  pi.registerCommand('phi-shake-oracle', {
    description: 'Private actual default-shake oracle',
    handler: async (args, ctx) => {
      const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session
      if (!session || session.sessionManager !== ctx.sessionManager)
        throw new Error('Actual SDK manager required')
      if (args === 'stats') {
        ctx.ui.notify(JSON.stringify({ type: 'shake_stats', providerCalls }), 'info')
        return
      }
      if (args !== 'create' && args !== 'create-long-line')
        throw new Error('Unknown private shake fixture command')
      const manager = session.sessionManager
      if (created) await manager.newSession()
      created = true
      manager.appendModelChange('fixture/current', 'default')
      manager.appendMessage({
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'shake-native-1', name: 'shake_fixture', arguments: {} },
          { type: 'toolCall', id: 'shake-native-2', name: 'shake_fixture', arguments: {} }
        ],
        api: 'openai-completions',
        provider: 'fixture',
        model: 'current',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'toolUse',
        timestamp: Date.now()
      })
      for (const [index, text] of [
        args === 'create-long-line'
          ? 'A'.repeat(131_000)
          : 'first durable shake region exact line\n'.repeat(2_000),
        'second durable shake region exact line\n'.repeat(2_000)
      ].entries())
        manager.appendMessage({
          role: 'toolResult',
          toolCallId: 'shake-native-' + (index + 1),
          toolName: 'shake_fixture',
          content: [{ type: 'text', text }],
          isError: false,
          timestamp: Date.now()
        })
      manager.appendMessage({
        role: 'user',
        content: 'Retained ordinary live tail content. '.repeat(12_000),
        timestamp: Date.now()
      })
      await manager.ensureOnDisk()
      const result = await session.shake('elide', { config: DEFAULT_SHAKE_CONFIG })
      await session.flushToDisk()
      const messages = manager
        .getEntries()
        .flatMap((entry) =>
          entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message] : []
        )
      if (
        result.toolResultsDropped !== 2 ||
        !result.artifactId ||
        messages.some((message) => message.prunedAt === undefined)
      )
        throw new Error('Actual default-shake did not rewrite both real tool results')
      ctx.ui.notify(
        JSON.stringify({
          type: 'shake_created',
          id: manager.getSessionId(),
          path: manager.getSessionFile(),
          artifactId: result.artifactId,
          markers: messages.map((message) => ({
            toolName: message.toolName,
            prunedAt: message.prunedAt,
            content: message.content
          })),
          protectTokens: DEFAULT_SHAKE_CONFIG.protectTokens,
          minSavings: DEFAULT_SHAKE_CONFIG.minSavings
        }),
        'info'
      )
    }
  })
}
