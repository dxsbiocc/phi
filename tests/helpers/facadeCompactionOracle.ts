import assert from 'node:assert/strict'
import { writeFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { facadeMetadataFixture } from './facadeMetadataFixture'
import { startHostResultModel } from './rpcHostResultModel'
import { runCompactionCancellation } from './facadeCompactionCancellationOracle'
import { runCompactionBoundary } from './facadeCompactionBoundaryOracle'
import { runAutomaticCompaction } from './facadeCompactionAutomaticOracle'
import { createRunId, findPhiSessionById } from '../../src/main/agent/session/session-store'

const mode = process.env.PHI_FACADE_COMPACTION_MODE!
let summaryRequests = 0
await writeFile(
  join(process.env.PI_CODING_AGENT_DIR!, 'config.yml'),
  JSON.stringify({
    compaction:
      mode === 'defaults-native'
        ? undefined
        : mode === 'defaults-fixed'
          ? { enabled: true, thresholdPercent: -1, thresholdTokens: 25000, methodOrder: ['soft'] }
          : mode.startsWith('defaults-')
            ? {
                enabled: mode === 'defaults-empty',
                thresholdPercent: 80,
                thresholdTokens: 12000,
                methodOrder: []
              }
            : {
                enabled: mode !== 'model-thresholds' && mode !== 'automatic',
                thresholdPercent: 90,
                thresholdTokens: -1,
                methodOrder: ['soft']
              }
  })
)
const f = await facadeMetadataFixture({
  isolatedProject: true,
  contextWindow: mode === 'automatic' ? 65536 : 1_000_000,
  applicationRouting: { agents: [] },
  providerFactory: () =>
    startHostResultModel({
      replyFor: (request) => {
        if (
          !request.messages.some(
            (message) =>
              message.role === 'system' &&
              JSON.stringify(message.content).includes(
                'NEVER continue the conversation or answer its questions. Output ONLY the structured summary.'
              )
          )
        )
          return undefined
        summaryRequests++
        console.log('phase summary-request', summaryRequests)
        return {
          text: 'COMPACTION_SUMMARY: Original marker was written once. Continue only on a new user request.',
          hold: mode === 'cancel' || mode === 'lost-outcome'
        }
      }
    })
})
let proxy = (await f.createApplicationSession()).session
console.log('phase session-ready')
async function prompt(text: string): Promise<void> {
  const run = f.runners.startRun({
    sessionId: f.phi.sessionId,
    runId: createRunId(),
    execute: () => proxy.prompt(text)
  })
  await run.done
  assert.equal(run.outcome, 'completed')
}
try {
  if (mode === 'automatic') {
    await runAutomaticCompaction(f, proxy, () => summaryRequests)
  } else if (
    [
      'busy',
      'approval',
      'lookup-abort',
      'lookup-binding',
      'manual-lookup-abort',
      'manual-lookup-binding'
    ].includes(mode)
  ) {
    await runCompactionBoundary(f, proxy, mode)
  } else if (
    mode === 'settings' ||
    mode === 'settings-recovery' ||
    mode.startsWith('defaults-') ||
    mode === 'model-thresholds'
  ) {
    const original = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
    const baseline =
      mode === 'defaults-native' || mode === 'defaults-fixed'
        ? {
            enabled: true,
            thresholdPercent: -1,
            thresholdTokens: mode === 'defaults-fixed' ? 25000 : -1
          }
        : mode.startsWith('defaults-')
          ? { enabled: false, thresholdPercent: 80, thresholdTokens: 12000 }
          : { enabled: mode !== 'model-thresholds', thresholdPercent: 90, thresholdTokens: -1 }
    assert.deepEqual(await proxy.getAutoCompactionSettings!(), { ...baseline, defaults: baseline })
    if (mode === 'model-thresholds') {
      const channels = f.channels.length
      await writeFile(
        join(process.env.PI_CODING_AGENT_DIR!, 'config.yml'),
        JSON.stringify({
          compaction: {
            enabled: false,
            thresholdPercent: 90,
            thresholdTokens: -1,
            methodOrder: [],
            modelThresholds: { 'phi-facade-regression/model-a': '80%' }
          }
        })
      )
      await assert.rejects(
        proxy.setAutoCompactionSettings({ enabled: false }),
        /does not yet support inherited per-model/
      )
      assert.equal(
        f.channels.length,
        channels,
        'unsupported policy must not retire the original generation'
      )
      assert.equal(f.engine.sessions.has(proxy.runtimeSessionId), true)
      assert.equal(findPhiSessionById(f.phi.sessionId)!.autoCompaction, undefined)
    } else if (mode === 'settings') {
      for (const thresholdPercent of [70, 80, 90] as const) {
        const receipt = await proxy.setAutoCompactionSettings({ enabled: false, thresholdPercent })
        assert.deepEqual(receipt, {
          enabled: false,
          thresholdPercent,
          thresholdTokens: -1,
          defaults: baseline
        })
        assert.deepEqual(
          await proxy.getAutoCompactionSettings!(),
          receipt,
          'real loaded policy readback must match the confirmed setter'
        )
        assert.deepEqual(findPhiSessionById(f.phi.sessionId)!.autoCompaction, {
          enabled: false,
          thresholdPercent
        })
      }
      await proxy.setAutoCompactionSettings({})
      assert.deepEqual(await proxy.getAutoCompactionSettings!(), {
        ...baseline,
        defaults: baseline
      })
      assert.equal(findPhiSessionById(f.phi.sessionId)!.autoCompaction, undefined)
    } else if (mode === 'settings-recovery') {
      await proxy.setAutoCompactionSettings({ enabled: false, thresholdPercent: 80 })
      await proxy.setModel(f.model('model-b'))
      const desired = {
        enabled: false,
        thresholdPercent: 80,
        thresholdTokens: -1,
        defaults: baseline
      }
      assert.deepEqual(
        await proxy.getAutoCompactionSettings!(),
        desired,
        'model rotation must reapply the saved policy'
      )
      await proxy.dispose()
      f.resume()
      proxy = (await f.createApplicationSession()).session
      assert.equal(proxy.model?.id, 'model-b')
      assert.deepEqual(
        await proxy.getAutoCompactionSettings!(),
        desired,
        'explicit same-journal recovery must retain the confirmed policy'
      )
      assert.equal(proxy.messages.length, 0)
    } else {
      const receipt = await proxy.setAutoCompactionSettings({ enabled: true, thresholdPercent: 70 })
      assert.deepEqual(receipt, {
        enabled: true,
        thresholdPercent: 70,
        thresholdTokens: -1,
        defaults: baseline
      })
      assert.deepEqual(await proxy.getAutoCompactionSettings!(), receipt)
      await proxy.setAutoCompactionSettings({})
      assert.deepEqual(
        await proxy.getAutoCompactionSettings!(),
        { ...baseline, defaults: baseline },
        'inherit resets absolute tokens and empty methods exactly'
      )
    }
    const latest = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
    assert.equal(latest.ompSessionId, original.ompSessionId)
    assert.equal(latest.journalBasename, original.journalBasename)
    assert.equal(
      f.provider.requests.length,
      0,
      'settings/control/recovery cannot invoke a provider or replay tools'
    )
  } else {
    f.configureApproval({
      shouldGate: () => false,
      requestToolApproval: () => {
        throw new Error('Unexpected automatic approval')
      }
    })
    const path = join(f.f.scope.projectRoot, 'original-write.txt')
    f.provider.enqueue(
      {
        tool: {
          name: 'write',
          args: { path: 'original-write.txt', content: 'Original tool executes once' }
        }
      },
      { text: 'Older explicit conversation retained' },
      { text: 'Recent explicit conversation retained' }
    )
    await prompt(
      'Create the authorized fixture marker. ' +
        'alpha beta gamma delta retained source fact 123456789.\n'.repeat(3000)
    )
    await prompt('theta lambda omicron actual context 987654321.\n'.repeat(3000))
    if (mode === 'after-aborted') {
      const requests = f.provider.requests.length
      f.provider.enqueue({ text: 'Interrupted original turn must never continue', hold: true })
      const running = f.runners.startRun({
        sessionId: f.phi.sessionId,
        runId: createRunId(),
        execute: () => proxy.prompt('Original interrupted turn must not replay')
      })
      while (f.provider.requests.length === requests)
        await new Promise((resolve) => setTimeout(resolve, 10))
      f.runners.stopRun(f.phi.sessionId)
      await proxy.abort()
      await running.done
      assert.equal(running.outcome, 'stopped')
      console.log('phase prior-turn-aborted')
    }
    console.log('phase seeds-ready')
    const usageBefore = await proxy.getContextUsage()
    console.log('phase original-context', JSON.stringify(usageBefore))
    assert.equal(usageBefore?.contextWindow, 1_000_000)
    const before = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
    const requests = f.provider.requests.length
    const original = await stat(path)
    if (mode === 'cancel' || mode === 'lost-outcome') {
      await runCompactionCancellation(f, proxy, {
        mode,
        summaryRequests: () => summaryRequests,
        marker: path
      })
    } else {
      console.log('phase compact-dispatch')
      const result = await proxy.compact()
      console.log('phase compact-checkpoint-confirmed')
      assert.match(result.summary, /COMPACTION_SUMMARY/)
      assert.ok(Number.isFinite(result.tokensBefore) && result.tokensBefore >= 0)
      const usageAfter = await proxy.getContextUsage()
      assert.ok(
        usageAfter && usageBefore && usageAfter.tokens < usageBefore.tokens,
        'actual context usage must decrease'
      )
      assert.ok(summaryRequests > 0)
      assert.equal(
        f.provider.requests.length,
        requests + summaryRequests,
        'only intentional SDK summary model requests'
      )
      const after = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
      assert.equal(after.ompSessionId, before.ompSessionId)
      assert.equal(after.journalBasename, before.journalBasename)
      assert.notEqual(after.checkpoint?.leafId, before.checkpoint?.leafId)
      assert.equal(
        (await stat(path)).mtimeMs,
        original.mtimeMs,
        'compaction cannot replay old tools'
      )
      assert.equal(await readFile(path, 'utf8'), 'Original tool executes once')
      f.provider.enqueue({ text: 'Responded only after the next explicit request' })
      await prompt('Continue from the confirmed summary')
      assert.equal(f.provider.requests.length, requests + summaryRequests + 1)
      assert.match(JSON.stringify(f.provider.requests.at(-1)!.messages), /COMPACTION_SUMMARY/)
      if (mode === 'manual') {
        const providerCount = f.provider.requests.length
        await proxy.dispose()
        f.resume()
        proxy = (await f.createApplicationSession()).session
        assert.equal(
          findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
          before.journalBasename
        )
        assert.match(JSON.stringify(proxy.messages), /COMPACTION_SUMMARY/)
        assert.equal(
          f.provider.requests.length,
          providerCount,
          'manual summary recovery cannot replay tools or provider work'
        )
        assert.equal((await stat(path)).mtimeMs, original.mtimeMs)
      }
    }
  }
  console.log(
    JSON.stringify({ mode, requests: f.provider.requests.length, channels: f.channels.length })
  )
} finally {
  console.log(
    'compaction fixture receipts',
    JSON.stringify({ summaryRequests, providerRequests: f.provider.requests.length })
  )
  await proxy.dispose().catch(() => undefined)
  await f.close()
}
