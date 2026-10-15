import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import type { RuntimeAgentSession } from '../../src/main/agent/runtime/runtime-adapter'
import { createRunId, findPhiSessionById } from '../../src/main/agent/session/session-store'
import { remoteOmpJournalPath } from '../../src/main/agent/session/runtime-reference'

/** Real automatic maintenance through the application installer and existing event projection. */
export async function runAutomaticCompaction(
  f: FacadeMetadataFixture,
  proxy: RuntimeAgentSession,
  summaries: () => number
): Promise<void> {
  f.configureApproval({ shouldGate: () => false, requestToolApproval: () => 'denied' })
  const events: Array<Record<string, unknown>> = []
  const detach = proxy.subscribe((event) => events.push(event as Record<string, unknown>))
  const prompt = async (text: string): Promise<void> => {
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => proxy.prompt(text)
    })
    await run.done
    assert.equal(run.outcome, 'completed')
  }
  try {
    f.provider.enqueue(
      { tool: { name: 'write', args: { path: 'auto-original.txt', content: 'once' } } },
      { text: 'First original explicit answer' },
      { text: 'Second original explicit answer' }
    )
    await prompt(
      'Original write: ' + 'alpha beta gamma delta retained fact 123456789.\n'.repeat(1300)
    )
    await prompt(
      'Second archive: ' + 'theta lambda omicron actual context 987654321.\n'.repeat(1300)
    )
    console.log('phase auto-seeds-ready')
    const before = await proxy.getContextUsage()
    assert.ok(before && before.percent < 70)
    const marker = join(f.f.scope.projectRoot, 'auto-original.txt'),
      oldMarker = await stat(marker)
    await proxy.setAutoCompactionSettings({ enabled: true, thresholdPercent: 70 })
    assert.equal((await proxy.getAutoCompactionSettings!())!.enabled, true)
    const requests = f.provider.requests.length
    f.provider.enqueue({ text: 'Only this explicit threshold-crossing answer' })
    await prompt(
      'Cross threshold: ' + 'tau sigma actual additional retained data 123456789.\n'.repeat(1400)
    )
    console.log('phase auto-threshold-turn-settled', JSON.stringify(await proxy.getContextUsage()))
    const journal = remoteOmpJournalPath(findPhiSessionById(f.phi.sessionId)!.runtimeRef!)
    const entries = (await readFile(journal, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.ok(
      entries.some((entry) => entry.type === 'compaction'),
      'real maintenance must commit a summary'
    )
    const start = events.findIndex((event) => event.type === 'auto_compaction_start')
    const end = events.findIndex(
      (event) => event.type === 'auto_compaction_end' && event.result !== undefined
    )
    assert.ok(start >= 0 && end > start, 'actual maintenance events retain their application path')
    assert.equal(events[start].reason, 'threshold')
    assert.equal(events[start].action, 'context-full')
    assert.equal(events[end].aborted, false)
    assert.ok(summaries() > 0)
    assert.equal(
      f.provider.requests.length,
      requests + summaries() + 1,
      'only intentional summaries and the explicit main turn'
    )
    assert.equal((await stat(marker)).mtimeMs, oldMarker.mtimeMs)
    assert.equal(await readFile(marker, 'utf8'), 'once')
    const count = f.provider.requests.length
    await proxy.dispose()
    f.resume()
    const fresh = (await f.createApplicationSession()).session
    try {
      assert.equal(
        f.provider.requests.length,
        count,
        'explicit restore cannot replay auto maintenance or original tools'
      )
      assert.equal((await fresh.getAutoCompactionSettings!())!.thresholdPercent, 70)
    } finally {
      await fresh.dispose()
    }
  } finally {
    detach()
  }
}
