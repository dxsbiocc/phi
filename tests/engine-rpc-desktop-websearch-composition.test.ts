import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { desktopWebSearchFixture } from './helpers/desktopWebSearchFixture'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'
import { createRpcDesktopToolScope } from '../src/main/agent/engine/rpc/desktop-tool-scope'
import { HostServiceRegistry } from '../src/main/agent/engine/host-service-registry'
import { BrowserTextVault } from '../src/main/agent/browser/browser-text-vault'
import type { RemoteSessionRuntime } from '../src/main/agent/engine/rpc/remote-session-runtime'
import { scanPersistentLauncherFiles } from './helpers/persistentLauncherFixture'

/** Actual SDK search → Phi host policy → selected server host result envelope → durable SDK history. */
test(
  'genuine desktop SDK search passes real RPC composition, full chunked result/history and no desktop credentials',
  { timeout: 90_000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    f.beforeLaunch(async (path) => {
      const { writeFile } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      await writeFile(
        join(dirname(path), 'home/.omp/agent/config.yml'),
        JSON.stringify({ compaction: { enabled: false } })
      )
    })
    const search = await desktopWebSearchFixture()
    t.after(() => search.close())
    const secret = 'desktop-search-synthetic-secret'
    await search.configure({ searxng: { endpoint: search.endpoint, token: secret } })
    const answer = 'search-full-result-'.repeat(70_000) + 'full-tail-marker'
    search.respond((_request, response) =>
      response.end(
        JSON.stringify({
          answers: [answer],
          results: [
            {
              title: 'Actual source',
              url: 'https://example.org/full',
              content: 'source metadata retained',
              engine: 'fixture'
            }
          ]
        })
      )
    )
    const identity = {
      runtimeSessionId: f.defaults.params.sessionId,
      sessionId: f.f.scope.phiSessionId,
      projectId: f.f.scope.projectId,
      cwd: f.f.scope.projectRoot
    }
    const adapter = await search.adapter({ identity })
    const owner: { current?: RemoteSessionRuntime } = {}
    const scope = createRpcDesktopToolScope({
      identity,
      desktopWebSearch: adapter,
      services: new HostServiceRegistry(),
      currentRun: () => owner.current?.currentRun(),
      recentUserImages: () => [],
      allowBrowserTypeText: () => false,
      browserTextVault: new BrowserTextVault(),
      agentDir: search.agentDir,
      allowedSkills: [],
      scriptTools: []
    })
    t.after(() => scope.dispose())
    let approvals = 0
    const runtime = await f.create({
      tools: scope.tools,
      hostApprovalFor: scope.approvalFor,
      approval: {
        shouldGate: () => {
          approvals++
          return true
        },
        requestToolApproval: () => {
          throw new Error('Read search must not request a write approval')
        }
      }
    })
    owner.current = runtime
    await f.sdk.enqueue(
      {
        tool: { name: 'web_search', id: 'search-composed', args: { query: 'test complete result' } }
      },
      { text: 'Search accepted' }
    )
    const turn = await runtime.prompt('phi-search-composed', 'Perform a web search')
    assert.equal(turn.outcome, 'completed')
    assert.equal(approvals, 0)
    const result = turn.snapshot.messages.findLast(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        message.role === 'toolResult' &&
        'toolCallId' in message &&
        message.toolCallId === 'search-composed'
    )
    assert.ok(result && typeof result === 'object' && 'details' in result && 'content' in result)
    assert.equal(JSON.stringify(result).includes('full-tail-marker'), true)
    assert.equal(JSON.stringify(result).includes('source metadata retained'), true)
    assert.ok(Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024)
    assert.equal(JSON.stringify(result).includes(secret), false)
    const journal = await readFile(turn.snapshot.checkpoint.journalPath, 'utf8')
    assert.ok(journal.includes('search-composed'))
    assert.ok(!journal.includes(secret))
    const remoteFiles = await scanPersistentLauncherFiles(f.f.paths.directory)
    for (const file of remoteFiles)
      assert.equal(file.bytes.includes(Buffer.from(secret)), false, file.path)
    const [nonce] = await readdir(join(f.f.runtimeRoot, 'rpc-sessions'))
    const config = await readFile(
      join(f.f.runtimeRoot, 'rpc-sessions', nonce, 'runtime.json'),
      'utf8'
    )
    for (const privateValue of [secret, search.agentDir, search.resourceCwd, search.endpoint])
      assert.equal(config.includes(privateValue), false)
    assert.equal(JSON.stringify(f.wire).includes(secret), false)
    assert.equal(JSON.stringify((await f.sdk.snapshot()).providerRequests).includes(secret), false)
    assert.equal(search.requests.at(-1)?.headers.authorization, 'Bearer ' + secret)
    await runtime.close()
    const restored = await f.create({
      tools: scope.tools,
      hostApprovalFor: scope.approvalFor,
      action: { type: 'resume', reference: turn.snapshot.reference, savedModel: f.ref }
    })
    owner.current = restored
    const reopenedResult = restored
      .currentSnapshot()
      .messages.findLast(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'role' in message &&
          message.role === 'toolResult'
      )
    assert.ok(
      reopenedResult &&
        typeof reopenedResult === 'object' &&
        'content' in reopenedResult &&
        'details' in reopenedResult &&
        'isError' in reopenedResult
    )
    // The pinned SDK truncates ordinary persisted strings at 500k chars. Compare a real
    // standalone SessionManager roundtrip; this adapter must not promise a stronger contract.
    const nativePersisted = await search.sdk('search-persist', {
      query: 'native persistence baseline'
    })
    assert.deepEqual(
      {
        content: reopenedResult.content,
        details: reopenedResult.details,
        isError: reopenedResult.isError
      },
      nativePersisted
    )
    assert.match(JSON.stringify(reopenedResult), /Session persistence truncated large content/)
    assert.equal(search.requests.length, 2, 'restoration must not replay the search')
    search.respond((_request, response) =>
      response.end(
        JSON.stringify({
          answers: ['normal-size-full-tail-marker'],
          results: [
            {
              title: 'Normal source',
              url: 'https://example.org/normal',
              content: 'normal source metadata'
            }
          ]
        })
      )
    )
    await f.sdk.enqueue(
      { tool: { name: 'web_search', id: 'search-normal', args: { query: 'normal search' } } },
      { text: 'Normal result accepted' }
    )
    const normal = await restored.prompt('phi-search-normal', 'Search again')
    assert.equal(normal.outcome, 'completed')
    await restored.close()
    const normalRestored = await f.create({
      tools: scope.tools,
      hostApprovalFor: scope.approvalFor,
      action: { type: 'resume', reference: normal.snapshot.reference, savedModel: f.ref }
    })
    owner.current = normalRestored
    assert.ok(
      JSON.stringify(normalRestored.currentSnapshot().messages).includes(
        'normal-size-full-tail-marker'
      )
    )
    assert.ok(
      JSON.stringify(normalRestored.currentSnapshot().messages).includes('normal source metadata')
    )
    assert.equal(search.requests.length, 3, 'fresh resume must not replay normal searches')
    const marker = join(search.root, 'remote-command-must-not-run')
    const { writeFile, access } = await import('node:fs/promises')
    await writeFile(
      join(search.agentDir, 'models.yml'),
      JSON.stringify({
        providers: { brave: { apiKey: `!touch '${marker}'; printf synthetic-never-key` } }
      })
    )
    await f.sdk.enqueue(
      {
        tool: {
          name: 'web_search',
          id: 'search-command-blocked',
          args: { query: 'unsupported credential search' }
        }
      },
      { text: 'Search capability unavailable' }
    )
    const blocked = await normalRestored.prompt(
      'phi-search-command-blocked',
      'Search with the configured credential'
    )
    const blockedResult = blocked.snapshot.messages.findLast(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        message.role === 'toolResult' &&
        'toolCallId' in message &&
        message.toolCallId === 'search-command-blocked'
    )
    assert.ok(
      blockedResult &&
        typeof blockedResult === 'object' &&
        'isError' in blockedResult &&
        blockedResult.isError === true
    )
    assert.match(JSON.stringify(blockedResult), /command-backed.*unsupported/i)
    assert.equal(JSON.stringify(blockedResult).includes(marker), false)
    assert.equal(JSON.stringify(blockedResult).includes('synthetic-never-key'), false)
    assert.equal(
      search.requests.length,
      3,
      'unsupported configuration must not call a search provider'
    )
    await assert.rejects(access(marker), { code: 'ENOENT' })
    assert.equal(
      approvals,
      0,
      'read search capability failure must not become a generic write approval'
    )
    await normalRestored.close()
  }
)
