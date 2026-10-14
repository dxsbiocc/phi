import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { facadeMetadataFixture } from './facadeMetadataFixture'
import { installFlockShim } from './flockShim'
import { RemoteLibraryService } from '../../src/main/agent/engine/rpc/remote-library-service'
import { SshHost } from '../../src/main/agent/workspace-host/ssh-host'
import { createRemoteRuntimeInputExec } from '../../src/main/agent/remote-runtime/input-exec'
import { resolveRemoteWorkspaceHostBinding } from '../../src/main/agent/remote-workspace-boundary'
import { getRemoteHostProfile, saveRemoteHostProfile } from '../../src/main/agent/remote-hosts'
import {
  createRunId,
  findPhiSessionById,
  readSessionEvents
} from '../../src/main/agent/session/session-store'
import type { AppRemoteSessionRoutingOptions } from '../../src/main/agent/remote-session-routing'
import { desktopWebSearchFixture } from './desktopWebSearchFixture'
import { runApplicationInteractionScenario } from './facadeInteractionOracle'
import { createApplicationSkillHarness } from './facadeSkillOracle'
import { runApplicationBrowserScenario } from './facadeBrowserOracle'
import { runApplicationDownloadScenario } from './facadeDownloadOracle'
import { runApplicationNotebookExecutionScenario } from './facadeNotebookExecutionOracle'
import { desktopMcpFixture } from './desktopMcpFixture'

const mode = process.env.PHI_FACADE_DESKTOP_MODE!
const search = mode.startsWith('search-') ? await desktopWebSearchFixture() : undefined
const mcp = mode.startsWith('mcp-') ? await desktopMcpFixture() : undefined
let skills: ReturnType<typeof createApplicationSkillHarness> | undefined
type Identity = Parameters<NonNullable<AppRemoteSessionRoutingOptions['loadDesktopTools']>>[0]
const identities = new Map<string, Identity>()
const f = await facadeMetadataFixture({
  isolatedProject: true,
  applicationRouting: {
    agents: [],
    loadDesktopTools: async (identity, signal) => {
      identities.set(identity.runtimeSessionId, identity)
      if (skills) return skills.resources(identity, signal)
      const adapter = search && (await search.adapter({ identity, signal }))
      const mcpAdapter =
        mcp && (await mcp.adapter({ identity, signal, approvalFor: () => 'write' }))
      return {
        tools: {
          allowedSkills: [],
          scriptTools: [],
          remoteLibrary: true,
          paletteCatalogPath: join(process.cwd(), 'resources/palettes/palettes.yaml'),
          desktopWebSearch: adapter,
          desktopMcp: mcpAdapter
        },
        close: async () => {
          adapter?.retire()
          mcpAdapter?.retire()
          await adapter?.close()
          await mcpAdapter?.close()
        }
      }
    }
  }
})
if (/^(skill|environment)-/.test(mode)) skills = createApplicationSkillHarness(f, mode)
const root = f.f.scope.projectRoot
const restoreFlock = installFlockShim(join(root, 'flock-shim'))
const hosts: SshHost[] = []
let lookupReady = false,
  releaseLookup: (() => void) | undefined
let effects = 0
const service = new RemoteLibraryService(async (identity, signal) => {
  const selected = identities.get(identity.runtimeSessionId)
  assert.ok(selected)
  assert.equal(selected.sessionId, identity.sessionId)
  assert.equal(selected.projectId, identity.projectId)
  const boundary = { sessionId: identity.sessionId, projectId: identity.projectId }
  const binding = resolveRemoteWorkspaceHostBinding(boundary)
  const run = f.runners.getActiveRun(identity.sessionId)
  assert.ok(run)
  const assertCurrent = (): void => {
    signal.throwIfAborted()
    run.signal.throwIfAborted()
    assert.equal(f.runners.getActiveRun(identity.sessionId), run)
    assert.equal(
      resolveRemoteWorkspaceHostBinding(boundary).cacheKey,
      binding.cacheKey,
      'Library binding changed'
    )
  }
  if (mode.startsWith('library-lookup-')) {
    lookupReady = true
    await new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
  }
  assertCurrent()
  const host = new SshHost({
    remoteRoot: selected.cwd,
    canonicalRoot: selected.cwd,
    connect: async () => ({ ...f.f.session, ...f.hostSession, close: async () => undefined })
  })
  hosts.push(host)
  const execute = createRemoteRuntimeInputExec(async () => ({
    ...f.f.session,
    ...f.hostSession,
    close: async () => undefined
  }))
  return {
    workspace: {
      projectHost: host,
      runtimeHost: host,
      projectRoot: selected.cwd,
      runtimeRoot: f.f.runtimeRoot,
      execWithInput: (script, options) => {
        assertCurrent()
        effects += 1
        return execute(script, { ...options, beforeExec: assertCurrent })
      },
      close: async () => undefined
    },
    openLockStdio: async (command) => {
      assertCurrent()
      const process = await f.hostSession.openStdio!(command)
      try {
        assertCurrent()
        return process
      } catch (error) {
        await process.close()
        throw error
      }
    }
  }
})
f.engine.host.register('library.execute', (value, context) => service.execute(value, context))
f.engine.host.register('library.cancel', (value, context) => service.cancel(value, context))
let approve: ((decision: 'approved') => void) | undefined
f.configureApproval({
  shouldGate: () => true,
  requestToolApproval: async (request) => {
    assert.equal(request.sessionId, f.phi.sessionId)
    if (mode.endsWith('-denied')) return 'denied'
    if (mode === 'library-pending-stop')
      return new Promise((resolve) => {
        approve = resolve
      })
    return 'approved'
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
async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now()
  while (!check()) {
    assert.ok(Date.now() - started < 15000, 'Desktop app scenario missed its boundary')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
let proxy: import('../../src/main/agent/runtime/runtime-adapter').RuntimeAgentSession | undefined
if (!skills && !/^(interaction|browser|download|notebook-execution)-/.test(mode))
  proxy = (await f.createApplicationSession()).session
const run = async (prompt: string): Promise<void> => {
  const current = f.runners.startRun({
    sessionId: f.phi.sessionId,
    runId: createRunId(),
    execute: () => proxy!.prompt(prompt)
  })
  await current.done
}
try {
  if (skills) {
    await skills.run()
  } else if (mode.startsWith('notebook-execution-')) {
    await runApplicationNotebookExecutionScenario(f, mode)
  } else if (mode.startsWith('browser-') || mode.startsWith('download-')) {
    if (mode.startsWith('browser-')) await runApplicationBrowserScenario(f, mode)
    else await runApplicationDownloadScenario(f, mode)
  } else if (mode.startsWith('interaction-')) {
    await runApplicationInteractionScenario(f, mode)
  } else if (mode.startsWith('library-')) {
    f.provider.enqueue(
      {
        tool: {
          name: 'lib.save',
          args: { source: 'pubmed', sourceId: '12345', title: 'Selected remote paper' }
        }
      },
      ...(mode === 'library-flow'
        ? [
            { tool: { name: 'lib.list', args: {} } },
            { tool: { name: 'lib.find', args: { query: 'Selected remote paper' } } },
            { tool: { name: 'lib.update', args: { id: '12345', notes: 'Remote annotation' } } },
            { tool: { name: 'lib.audit', args: {} } }
          ]
        : []),
      { text: 'Library operation settled' }
    )
    const pending = run('Use the selected remote project literature library')
    if (mode === 'library-pending-stop' || mode.startsWith('library-lookup-')) {
      await waitFor(() => !!approve || lookupReady)
      if (mode === 'library-lookup-rebind') {
        const location = f.phi.manifest.projectLocation!
        assert.equal(location.kind, 'ssh')
        const profile = getRemoteHostProfile(location.kind === 'ssh' ? location.hostProfileId : '')!
        saveRemoteHostProfile({ ...profile, hostAlias: 'rebound-synthetic-host' })
      } else {
        f.runners.stopRun(f.phi.sessionId)
        await proxy!.abort()
      }
      approve?.('approved')
      releaseLookup?.()
    }
    await pending
    const index = join(root, '.phi/library/index.json')
    if (mode !== 'library-flow') {
      assert.equal(effects, 0)
      assert.equal(await f.exists(index), false)
      assert.equal(await f.exists(join(f.phi.manifest.cwd, '.phi/library/index.json')), false)
      if (mode === 'library-lookup-rebind')
        assert.match(
          JSON.stringify(f.provider.requests.at(-1)?.messages),
          /Library binding changed/
        )
    } else {
      assert.ok(
        await f.exists(index),
        JSON.stringify({ effects, messages: f.provider.requests.at(-1)?.messages })
      )
      const saved = await readFile(index, 'utf8')
      assert.match(saved, /Selected remote paper/)
      assert.match(saved, /Remote annotation/)
      assert.equal(await f.exists(join(f.phi.manifest.cwd, '.phi/library/index.json')), false)
      const requests = f.provider.requests.length
      const reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
      const originalId = proxy!.runtimeSessionId
      await proxy!.dispose()
      f.resume()
      proxy = (await f.createApplicationSession()).session
      assert.notEqual(proxy!.runtimeSessionId, originalId)
      assert.equal(
        f.provider.requests.length,
        requests,
        'fresh generation cannot replay model/tools'
      )
      assert.equal(await readFile(index, 'utf8'), saved)
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
        reference.journalBasename
      )
      f.provider.enqueue(
        { tool: { name: 'lib.list', args: {} } },
        { tool: { name: 'lib.remove', args: { id: '12345' } } },
        { text: 'Removed' }
      )
      await run('List the restored library and remove the same paper')
      assert.doesNotMatch(await readFile(index, 'utf8'), /Selected remote paper/)
      const events = readSessionEvents(f.phi.sessionId)
      const approvals = events.filter((event) => event.type === 'approval_requested')
      assert.equal(
        approvals.length,
        3,
        'save/update/remove persist one approval each; reads do not gate'
      )
      assert.equal(events.filter((event) => event.type === 'approval_approved').length, 3)
    }
  } else if (mode.startsWith('mcp-')) {
    f.provider.enqueue(
      {
        tool: {
          name: 'mcp__fixture_inspect',
          args: { operation: mode === 'mcp-stop' ? 'hold' : 'image' }
        }
      },
      { text: 'MCP settled' }
    )
    const pending = run('Use the trusted HTTPS MCP service')
    if (mode === 'mcp-stop') {
      await waitFor(() => mcp!.requests.some((request) => request.method === 'tools/call'))
      f.runners.stopRun(f.phi.sessionId)
      await proxy!.abort()
    }
    await pending
    const calls = (): number =>
      mcp!.requests.filter((request) => request.method === 'tools/call').length
    assert.equal(calls(), mode === 'mcp-denied' ? 0 : 1)
    if (mode === 'mcp-flow') {
      assert.match(JSON.stringify(proxy!.messages), /structuredContent|image/)
      const before = f.provider.requests.length
      const reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
      await proxy!.dispose()
      f.resume()
      proxy = (await f.createApplicationSession()).session
      assert.equal(f.provider.requests.length, before)
      assert.equal(calls(), 1)
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
        reference.journalBasename
      )
    }
  } else if (mode.startsWith('search-')) {
    let response: import('node:http').ServerResponse | undefined
    if (mode === 'search-stop')
      search!.respond((_request, res) => {
        response = res
      })
    f.provider.enqueue(
      { tool: { name: 'web_search', args: { query: 'selected remote research' } } },
      { text: 'Search settled' }
    )
    const pending = run('Search with the real desktop web adapter')
    if (mode === 'search-stop') {
      await waitFor(() => !!response)
      f.runners.stopRun(f.phi.sessionId)
      await proxy!.abort()
      response!.end(
        JSON.stringify({
          results: [
            { title: 'LATE_SEARCH_RESULT', url: 'https://example.org/late', content: 'late' }
          ]
        })
      )
    }
    await pending
    assert.ok(search!.requests.length > 0)
    const messages = JSON.stringify(f.provider.requests.at(-1)?.messages)
    if (mode === 'search-flow') assert.match(messages, /Fixture SearxNG/)
    else
      assert.doesNotMatch(JSON.stringify(readSessionEvents(f.phi.sessionId)), /LATE_SEARCH_RESULT/)
    assert.equal(
      readSessionEvents(f.phi.sessionId).filter((event) => event.type === 'approval_requested')
        .length,
      0
    )
  }
  console.log(JSON.stringify({ mode, requests: f.provider.requests.length, effects }))
} finally {
  service.dispose()
  await proxy?.dispose().catch(() => undefined)
  await Promise.allSettled(hosts.map((host) => host.close()))
  restoreFlock()
  await search?.close()
  await mcp?.close()
  await skills?.close()
  await f.close()
}
