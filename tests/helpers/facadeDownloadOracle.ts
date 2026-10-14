import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import { remoteDownloadFixture } from './remoteDownloadFixture'
import { getRemoteHostProfile } from '../../src/main/agent/remote-hosts'
import { resolveRemoteWorkspaceHostBinding } from '../../src/main/agent/remote-workspace-boundary'
import {
  createRunId,
  findPhiSessionById,
  readSessionEvents
} from '../../src/main/agent/session/session-store'

export async function runApplicationDownloadScenario(
  f: FacadeMetadataFixture,
  mode: string
): Promise<void> {
  const location = f.phi.manifest.projectLocation!
  assert.equal(location.kind, 'ssh')
  if (location.kind !== 'ssh') throw new Error('expected SSH fixture')
  const profile = getRemoteHostProfile(location.hostProfileId)!
  const download = remoteDownloadFixture({
    projectId: f.phi.manifest.projectId!,
    hostProfileId: location.hostProfileId,
    hostAlias: profile.hostAlias,
    anchor: f.phi.manifest.cwd,
    remoteRoot: f.f.scope.projectRoot,
    agentDir: process.env.PI_CODING_AGENT_DIR!
  })
  let proxy = (await f.createApplicationSession()).session
  f.engine.host.register('remoteWorkspace.download', (params, context) => {
    const value = params as { sessionId: string; projectId: string }
    assert.equal(context.originSessionId, proxy.runtimeSessionId)
    assert.equal(value.sessionId, f.phi.sessionId)
    assert.equal(value.projectId, f.phi.manifest.projectId)
    const boundary = { sessionId: value.sessionId, projectId: value.projectId }
    const binding = resolveRemoteWorkspaceHostBinding(boundary).cacheKey
    return download.manager.run(params, {
      signal: context.signal,
      beforeDispatch: () => {
        context.signal?.throwIfAborted()
        assert.equal(resolveRemoteWorkspaceHostBinding(boundary).cacheKey, binding)
      }
    })
  })
  f.engine.host.register('remoteWorkspace.cancelDownload', (params, context) => {
    assert.equal(context.originSessionId, proxy.runtimeSessionId)
    download.manager.cancel(params)
  })
  f.configureApproval({
    shouldGate: () => true,
    requestToolApproval: async (request) => {
      assert.equal(request.toolName, 'download_file')
      return mode === 'download-denied' ? 'denied' : 'approved'
    },
    onEvent: (event) => {
      if (event.type === 'approval_requested')
        f.runners.markNeedsApproval(event.sessionId, event.approvalId, {
          toolName: event.request.toolName,
          summary: event.request.summary
        })
      else if (event.type === 'approval_approved')
        f.runners.markApprovalApproved(event.sessionId, event.approvalId)
      else if (event.type === 'approval_denied')
        f.runners.markApprovalDenied(event.sessionId, event.approvalId)
      else f.runners.markApprovalCancelled(event.sessionId, event.approvalId)
    }
  })
  const request = download.request(f.phi.sessionId)
  try {
    if (mode === 'download-flow') download.allow()
    f.provider.enqueue(
      {
        tool: {
          name: 'download_file',
          args: {
            url: request.url,
            outputPath: 'owner.bin',
            maxFileBytes: request.maxFileBytes,
            expectedSha256: download.digest
          }
        }
      },
      { text: 'Download settled' }
    )
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => proxy.prompt('Download the tiny artifact into the selected remote project')
    })
    if (mode === 'download-stop') {
      const start = Date.now()
      while (!(await f.exists(download.startedPath()))) {
        assert.ok(Date.now() - start < 15000, 'real curl did not start')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      f.runners.stopRun(f.phi.sessionId)
      await proxy.abort()
      download.allow()
    }
    await run.done
    assert.equal(
      await readFile(join(download.anchor, 'owner.bin'), 'utf8'),
      'local anchor sentinel'
    )
    if (mode === 'download-flow') {
      assert.deepEqual(await readFile(join(download.remoteRoot, 'owner.bin')), download.bytes)
      assert.match(JSON.stringify(proxy.messages), new RegExp(`ssh://${profile.hostAlias}`))
      const before = f.provider.requests.length
      const reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
      const commands = download.sessions.flatMap((session) => session.commands).length
      await proxy.dispose()
      f.resume()
      proxy = (await f.createApplicationSession()).session
      assert.equal(f.provider.requests.length, before)
      assert.equal(download.sessions.flatMap((session) => session.commands).length, commands)
      assert.deepEqual(await readFile(join(download.remoteRoot, 'owner.bin')), download.bytes)
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
        reference.journalBasename
      )
    } else {
      assert.equal(await f.exists(join(download.remoteRoot, 'owner.bin')), false)
      if (mode === 'download-denied') assert.equal(download.sessions.length, 0)
    }
    assert.equal(
      readSessionEvents(f.phi.sessionId).filter((event) => event.type === 'approval_requested')
        .length,
      1
    )
  } finally {
    await proxy.dispose()
    await download.dispose()
  }
}
