import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { mock } from 'node:test'
import { facadeMetadataFixture } from './facadeMetadataFixture'
import { createLocalShellSession } from './localShellSession'
import { loadRemoteProjectInstructions } from '../../src/main/agent/remote-project-instructions'
import {
  createRuntimeAgentSession,
  type RuntimeAgentSession
} from '../../src/main/agent/runtime/runtime-adapter'
import { createAppRemoteSessionManager } from '../../src/main/agent/remote-session-routing'
import { createRunId, findPhiSessionById } from '../../src/main/agent/session/session-store'
import { saveRemoteHostProfile } from '../../src/main/agent/remote-hosts'
const mode = process.env.PHI_PROMPT_MODE!
let resolveLookup!: () => void,
  held = false
const gate = new Promise<void>((resolve) => {
  resolveLookup = resolve
})
await writeFile(
  join(process.env.PI_CODING_AGENT_DIR!, 'config.yml'),
  JSON.stringify({
    compaction: { enabled: false, thresholdPercent: 90, thresholdTokens: -1, methodOrder: ['soft'] }
  })
)
const f = await facadeMetadataFixture({
  isolatedProject: true,
  applicationRouting: {
    agents: [],
    loadPromptContext: async (_identity, signal) => {
      const personaMarkdown = await persona()
      const contextFiles = await context()
      if (mode === 'stop' || mode === 'rebind') {
        held = true
        await gate
      }
      signal.throwIfAborted()
      return {
        personaMarkdown,
        personaPath: join(process.env.PI_CODING_AGENT_DIR!, 'AGENTS.md'),
        contextFiles
      }
    }
  }
})
async function persona(): Promise<string> {
  try {
    return await readFile(join(process.env.PI_CODING_AGENT_DIR!, 'AGENTS.md'), 'utf8')
  } catch {
    return ''
  }
}
async function context(): Promise<Array<{ path: string; content: string }>> {
  const location = f.params('unused').remoteProject!.location
  if (location.kind !== 'ssh') throw new Error('Missing real fixture project')
  return loadRemoteProjectInstructions(location, {
    connectImpl: async () => createLocalShellSession()
  })
}
let recovery = false,
  proxy: RuntimeAgentSession | undefined
async function create(): Promise<RuntimeAgentSession> {
  const saved = findPhiSessionById(f.phi.sessionId)!
  return (
    await createRuntimeAgentSession({
      cwd: saved.cwd!,
      agentDir: process.env.PI_CODING_AGENT_DIR!,
      model: f.model(saved.model!.modelId),
      thinkingLevel: saved.thinkingLevel,
      autoCompaction: saved.autoCompaction,
      personaMarkdown: await persona(),
      projectBound: true,
      remoteProject: { ...f.params('unused').remoteProject!, contextFiles: await context() },
      sessionManager: createAppRemoteSessionManager(saved.cwd!, saved.sessionId, recovery)
    })
  ).session
}
async function until(check: () => boolean): Promise<void> {
  const start = Date.now()
  while (!check()) {
    assert.ok(Date.now() - start < 15000, 'prompt boundary did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
async function prompt(text: string): Promise<void> {
  f.provider.enqueue({ text: 'Only an explicit prompt produces this answer' })
  const run = f.runners.startRun({
    sessionId: f.phi.sessionId,
    runId: createRunId(),
    execute: () => proxy!.prompt(text)
  })
  await run.done
  assert.equal(run.outcome, 'completed')
}
function system(): string {
  return f.provider.requests
    .at(-1)!
    .messages.filter((message) => message.role === 'system')
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    )
    .join('\n')
}
function verify(withPersona: boolean): void {
  const text = system()
  assert.match(text, /You are the assistant running in Phi/)
  assert.doesNotMatch(text, /Helpful, trusted assistant for load-bearing changes in Oh My Pi/)
  for (const marker of ['ROOT_AGENT_RULE', 'ROOT_CLAUDE_RULE', 'ROOT_GEMINI_RULE'])
    assert.equal(text.split(marker).length - 1, 1)
  assert.doesNotMatch(text, /FOREIGN_GITHUB_RULE|FOREIGN_SYSTEM_RULE|remote-project-anchors/)
  assert.equal(text.split('PERSONA_ONLY_ONCE').length - 1, withPersona ? 1 : 0)
  assert.match(text, /ssh:\/\/synthetic-no-ssh/)
}
try {
  for (const [file, marker] of [
    ['AGENTS.md', 'ROOT_AGENT_RULE'],
    ['CLAUDE.md', 'ROOT_CLAUDE_RULE'],
    ['GEMINI.md', 'ROOT_GEMINI_RULE']
  ])
    await writeFile(join(f.f.scope.projectRoot, file), marker)
  await mkdir(join(f.f.scope.projectRoot, '.github'))
  await writeFile(
    join(f.f.scope.projectRoot, '.github/copilot-instructions.md'),
    'FOREIGN_GITHUB_RULE'
  )
  await writeFile(join(f.f.scope.projectRoot, 'SYSTEM.md'), 'FOREIGN_SYSTEM_RULE')
  if (mode === 'combined')
    await writeFile(
      join(process.env.PI_CODING_AGENT_DIR!, 'AGENTS.md'),
      'PERSONA_ONLY_ONCE: use the existing Phi identity'
    )
  if (mode === 'untrusted') {
    const files = await context()
    const params = f.params('untrusted-persona')
    await assert.rejects(
      f.engine.sessions.create({
        ...params,
        personaMarkdown: 'Untrusted persona',
        remoteProject: { ...params.remoteProject!, contextFiles: files }
      }),
      /untrusted persona/
    )
    await assert.rejects(
      f.engine.sessions.create({
        ...params,
        sessionId: 'untrusted-context',
        remoteProject: {
          ...params.remoteProject!,
          contextFiles: files.map((file, index) =>
            index === 0 ? { ...file, content: 'Untrusted replacement' } : file
          )
        }
      }),
      /untrusted persona or remote context/
    )
    assert.equal(f.channels.length, 0)
    assert.equal(f.provider.requests.length, 0)
    assert.equal(findPhiSessionById(f.phi.sessionId)!.runtimeRef, undefined)
  } else if (mode === 'stop' || mode === 'rebind' || mode === 'late-rebind') {
    let runtimeId = ''
    const original = f.engine.sessions.create.bind(f.engine.sessions)
    const probe = mock.method(f.engine.sessions, 'create', async (params) => {
      runtimeId = params.sessionId
      return original(params)
    })
    const openStdio = f.hostSession.openStdio!.bind(f.hostSession)
    const late =
      mode === 'late-rebind'
        ? mock.method(f.hostSession, 'openStdio', async (command: string) => {
            const channel = await openStdio(command)
            // The merged startup transaction replaced the per-file startup-policy
            // publication; hold the same in-flight startup at that command.
            if (command.includes('PHI_RPC_STARTUP_RESULT_END')) {
              held = true
              await gate
            }
            return channel
          })
        : undefined
    const pending = create(),
      rejected = assert.rejects(pending, /cancel|stopped|changed|改变|disposed|closing|abort/i)
    await until(() => held)
    let stopped: Promise<unknown> | undefined
    if (mode === 'stop') stopped = f.engine.sessions.dispose({ sessionId: runtimeId })
    else {
      const location = f.params('unused').remoteProject!.location
      saveRemoteHostProfile(
        { id: location.hostProfileId, label: 'Changed host', hostAlias: 'changed-fixture' },
        process.env.PI_CODING_AGENT_DIR!
      )
    }
    resolveLookup()
    await stopped
    await rejected
    probe.mock.restore()
    late?.mock.restore()
    assert.equal(f.channels.length, 0)
    assert.equal(f.provider.requests.length, 0)
    assert.equal(findPhiSessionById(f.phi.sessionId)!.runtimeRef, undefined)
  } else {
    proxy = await create()
    await prompt('Initial explicit prompt')
    verify(mode === 'combined')
    if (mode === 'combined') {
      const old = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
      const before = f.provider.requests.length
      await proxy.setModel(f.model('model-b'))
      assert.equal(f.provider.requests.length, before)
      await prompt('After model rotation')
      verify(true)
      await proxy.setAutoCompactionSettings({ enabled: false, thresholdPercent: 70 })
      assert.equal(f.provider.requests.length, before + 1)
      await prompt('After policy rotation')
      verify(true)
      await proxy.dispose()
      recovery = true
      proxy = await create()
      assert.equal(f.provider.requests.length, before + 2)
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
        old.journalBasename
      )
      await prompt('After explicit same-journal restore')
      verify(true)
      await proxy.dispose()
      await writeFile(join(process.env.PI_CODING_AGENT_DIR!, 'AGENTS.md'), '')
      proxy = await create()
      await prompt('Default Phi after removing persona')
      verify(false)
      assert.equal(f.provider.requests.length, 5)
    }
  }
  console.log(
    JSON.stringify({
      mode,
      providerRequests: f.provider.requests.length,
      channels: f.channels.length
    })
  )
} finally {
  resolveLookup()
  await proxy?.dispose().catch(() => undefined)
  await f.close()
}
