import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import {
  withAnthropicCompactionPreserveData,
  getAnthropicCompactionPayload
} from '@oh-my-pi/pi-agent-core/compaction'
import { registerRpcSessionVerification } from '../../src/main/agent/engine/phi-extension/extensions/rpc-session-verification'
import type { SessionVerificationIdentity } from '../../src/main/agent/engine/phi-extension/lib/rpc-session-verification-protocol'

export default function fixture(pi: ExtensionAPI): void {
  let providerCalls = 0
  pi.on('before_provider_request', () => {
    providerCalls++
    throw new Error('Verifier fixture must not invoke a provider')
  })
  const identity = JSON.parse(
    readFileSync(process.env.PHI_VERIFIER_FIXTURE!, 'utf8')
  ) as SessionVerificationIdentity
  const controller = new AbortController()
  let activeChecks = 0,
    revokeAt = Infinity
  let mutateAt = Infinity
  let mutate: (() => Promise<void>) | undefined
  let mutation: Promise<void> | undefined
  let lastCreated: string | undefined
  registerRpcSessionVerification(pi, {
    ...identity,
    signal: controller.signal,
    assertActive: () => {
      if (++activeChecks >= revokeAt) controller.abort()
      if (activeChecks === mutateAt && mutate) {
        mutation = mutate()
        void mutation.catch(() => undefined)
      }
      controller.signal.throwIfAborted()
    }
  })
  pi.registerCommand('phi-verifier-fixture', {
    description: 'Private verifier fixture',
    handler: async (args, ctx) => {
      const live = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session
      if (!live || live.sessionManager !== ctx.sessionManager)
        throw new Error('Fixture requires real live manager')
      if (args === 'stats') {
        await mutation
        ctx.ui.notify(
          JSON.stringify({
            type: 'fixture_stats',
            providerCalls,
            admitted: live.hasAdmittedSubmission,
            checks: activeChecks
          }),
          'info'
        )
        return
      }
      if (args === 'initialize') {
        await live.sessionManager.ensureOnDisk()
        ctx.ui.notify(
          JSON.stringify({
            type: 'fixture_live',
            path: ctx.sessionManager.getSessionFile(),
            id: ctx.sessionManager.getSessionId()
          }),
          'info'
        )
        return
      }
      if (args === 'live-pending') {
        live.sessionManager.appendCustomEntry('pending-fixture', { value: 'pending exact bytes' })
        return
      }
      if (args === 'live-add-artifact') {
        const id = await live.sessionManager.saveArtifact('new legitimate live artifact', 'fixture')
        live.sessionManager.appendMessage({
          role: 'toolResult',
          toolCallId: 'new-fixture',
          toolName: 'fixture',
          content: [{ type: 'text', text: 'new output' }],
          details: { meta: { truncation: { artifactId: id } } },
          isError: false,
          timestamp: Date.now()
        })
        return
      }
      if (args === 'native-spill') {
        const tool = live.agent.state.tools.find((tool) => tool.name === 'bash')
        if (!tool) throw new Error('Actual native Bash tool is unavailable')
        const result = await tool.execute(
          'native-spill-fixture',
          {
            command: 'awk \'BEGIN { for (i = 0; i < 50000; i++) print "native spill line " i }\'',
            timeout: 30
          },
          new AbortController().signal
        )
        live.sessionManager.appendMessage({
          role: 'toolResult',
          toolCallId: 'native-spill-fixture',
          toolName: 'bash',
          content: result.content,
          details: result.details,
          isError: false,
          timestamp: Date.now()
        })
        await live.flushToDisk()
        return
      }
      if (args === 'live-fail-flush') {
        const path = ctx.sessionManager.getSessionFile()!
        renameSync(path, path + '.original')
        mkdirSync(path, { mode: 0o700 })
        live.sessionManager.appendCustomEntry('failed-fixture', { value: 'must fail to persist' })
        return
      }
      if (args === 'revoke') {
        controller.abort()
        return
      }
      if (args === 'arm-revoke') {
        revokeAt = activeChecks + 50
        return
      }
      if (args === 'arm-leaf' || args.startsWith('arm-leaf-late ')) {
        const id = live.sessionManager.getEntries()[0].id
        mutate = async () => {
          live.sessionManager.branch(id)
        }
        const offset = args === 'arm-leaf' ? 50 : Number(args.slice('arm-leaf-late '.length))
        if (!Number.isSafeInteger(offset) || offset < 1 || offset > 1_000_000)
          throw new Error('Invalid mutation offset')
        mutateAt = activeChecks + offset
        return
      }
      if (args === 'arm-rebind') {
        const target = lastCreated
        if (!target || target === live.sessionManager.getSessionFile())
          throw new Error('Rebind fixture target is missing')
        mutate = () => live.sessionManager.setSessionFile(target)
        mutateAt = activeChecks + 50
        return
      }
      if (args === 'arm-project-replace') {
        mutate = async () => {
          renameSync(identity.projectRoot, identity.projectRoot + '.replaced')
          mkdirSync(identity.projectRoot, { mode: 0o700 })
        }
        mutateAt = activeChecks + 50
        return
      }
      const manager = pi.pi.SessionManager.create(ctx.cwd, identity.journals)
      const image = {
        type: 'image' as const,
        data: Buffer.alloc(100_000, 71).toString('base64'),
        mimeType: 'image/png'
      }
      let expected: string | null = null
      if (args !== 'header') {
        const first = manager.appendModelChange('fixture/old', 'default')
        manager.appendMessage({
          role: 'user',
          content: 'A normal blob:sha256:bad and artifact://999 are prose.',
          timestamp: Date.now()
        })
        manager.appendModelChange('fixture/discarded', 'default')
        manager.branch(first)
        manager.appendModelChange('fixture/current', 'default')
        expected = 'fixture/current'
        if (args === 'role') {
          manager.appendModelChange('fixture/small', 'smol')
          expected = 'fixture/small'
        }
        if (args === 'fallback') manager.appendModelChange('fixture/temporary', 'fallback', true)
        if (args === 'assistant-fallback')
          manager.appendMessage({
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'signed exact thinking',
                thinkingSignature: 'blob:sha256:opaque-signature'
              },
              { type: 'redactedThinking', data: 'artifact://opaque-encrypted-data' },
              { type: 'text', text: 'temporary provider response' }
            ],
            api: 'openai-completions',
            provider: 'fixture',
            model: 'temporary',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            },
            stopReason: 'stop',
            timestamp: Date.now()
          })
        if (args === 'user')
          manager.appendMessage({ role: 'user', content: [image], timestamp: Date.now() })
        if (args === 'tool')
          manager.appendMessage({
            role: 'toolResult',
            toolCallId: 'fixture-tool',
            toolName: 'fixture',
            content: [image],
            isError: false,
            timestamp: Date.now()
          })
        if (args === 'custom') manager.appendCustomMessageEntry('fixture-images', [image], true)
        if (args === 'images')
          manager.appendCustomEntry('fixture-provider', { payload: { images: [image] } })
        if (args === 'generation')
          manager.appendCustomEntry('fixture-provider', {
            payload: { type: 'image_generation_call', result: image.data }
          })
        if (args === 'image-url')
          manager.appendCustomEntry('fixture-provider', {
            payload: { image_url: 'data:image/png;base64,' + image.data }
          })
        if (args === 'snap')
          manager.appendCompaction('summary', undefined, first, 100, {
            preserveData: { snapcompact: { frames: [image] } }
          })
        if (args.startsWith('native-compaction')) {
          const through = manager.getLeafId()!
          manager.appendMessage({
            role: 'user',
            content: 'retained after native snapshot',
            timestamp: Date.now()
          })
          const preserveData = withAnthropicCompactionPreserveData(undefined, {
            provider: 'anthropic',
            content: 'SDK native full-prefix exact signed summary',
            signature: 'exact-native-signature/blob:sha256:opaque',
            exactTail: true,
            filesText: '<files>native metadata</files>',
            retainedFiles: [{ text: '<files>earlier metadata</files>', after: 1 }],
            model: 'claude-native-fixture',
            usedTokens: 123
          })
          const payload = getAnthropicCompactionPayload(preserveData)
          if (
            payload?.type !== 'anthropicCompaction' ||
            payload.content !== 'SDK native full-prefix exact signed summary'
          )
            throw new Error('Actual SDK native compaction serializer did not preserve payload')
          manager.appendCompaction(payload.content, 'Remote compaction', '', 123, {
            preserveData,
            ...(args === 'native-compaction-replay'
              ? { providerReplayThroughEntryId: through }
              : {})
          })
        }
        if (args.startsWith('artifact')) {
          const id = await manager.saveArtifact(
            args === 'artifact-large'
              ? 'streaming artifact exact bytes'.repeat(150_000)
              : 'original complete artifact\nhead\n[...middle elided...]\ntail',
            'fixture'
          )
          const meta =
            args === 'artifact-column'
              ? {
                  limits: {
                    columnTruncated: {
                      maxColumn: 8,
                      unit: 'chars',
                      artifactId: id,
                      selectorBase: `artifact://${id}:raw:1-4`
                    }
                  }
                }
              : args === 'artifact-source'
                ? { source: { type: 'internal', value: `artifact://${id}:1-4` } }
                : { truncation: { artifactId: id, totalBytes: 999999, outputBytes: 10 } }
          manager.appendMessage({
            role: 'toolResult',
            toolCallId: 'fixture-tool',
            toolName: 'fixture',
            content: [{ type: 'text', text: 'head/tail' }],
            details: { meta },
            isError: false,
            timestamp: Date.now()
          })
        }
        if (args === 'unicode')
          manager.appendMessage({
            role: 'user',
            content: '中文🙂'.repeat(100_000),
            timestamp: Date.now()
          })
      }
      await manager.ensureOnDisk()
      await manager.setSessionName('Actual SDK title fixture', 'user')
      await manager.flush()
      const path = manager.getSessionFile()!,
        id = manager.getSessionId()
      lastCreated = path
      const context = manager.buildSessionContext()
      if (args.startsWith('native-compaction')) {
        const summary = context.messages.find((message) => message.role === 'compactionSummary')
        if (
          !summary ||
          summary.role !== 'compactionSummary' ||
          summary.providerPayload?.type !== 'anthropicCompaction' ||
          summary.providerPayload.signature !== 'exact-native-signature/blob:sha256:opaque' ||
          summary.providerPayload.content !== 'SDK native full-prefix exact signed summary'
        )
          throw new Error('Actual SDK context did not reconstruct exact native compaction payload')
      }
      const candidates = pi.pi.getRestorableSessionModels(
        context.models,
        manager.getLastModelChangeRole()
      )
      const expectedModel = candidates[0] ?? null
      await manager.close()
      ctx.ui.notify(
        JSON.stringify({ type: 'fixture_created', path, id, expected, expectedModel }),
        'info'
      )
    }
  })
}
