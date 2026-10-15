import assert from 'node:assert/strict'
import { facadeMetadataFixture } from './facadeMetadataFixture'
import { startProjectMemoryModel } from './projectMemoryProvider'
import { createDesktopProjectMemoryAdapter } from '../../src/main/agent/engine/rpc/desktop-project-memory-adapter'
import {
  createRuntimeAgentSession,
  type RuntimeAgentSession
} from '../../src/main/agent/runtime/runtime-adapter'
import { createAppRemoteSessionManager } from '../../src/main/agent/remote-session-routing'
import { createRunId, findPhiSessionById } from '../../src/main/agent/session/session-store'
import { updateProjectMemory } from '../../src/main/agent/projects'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const agentDir = process.env.PI_CODING_AGENT_DIR!
await writeFile(
  join(agentDir, 'config.yml'),
  JSON.stringify({
    compaction: { enabled: false, thresholdPercent: 90, thresholdTokens: -1, methodOrder: ['soft'] }
  })
)
const f = await facadeMetadataFixture({
  isolatedProject: true,
  providerFactory: startProjectMemoryModel,
  applicationRouting: {
    agents: [],
    loadDesktopTools: async (identity, signal) => {
      const { resourceCwd, ...toolIdentity } = identity
      const memory = await createDesktopProjectMemoryAdapter({
        identity: toolIdentity,
        agentDir,
        resourceCwd,
        settings: { enabled: true, learn: true },
        signal
      })
      return { tools: { allowedSkills: [], scriptTools: [] }, memory, close: () => memory.close() }
    }
  }
})
const original = findPhiSessionById(f.phi.sessionId)!
updateProjectMemory(original.projectId!, { enabled: true, learn: true })
f.configureApproval({
  shouldGate: () => false,
  requestToolApproval: () => {
    throw new Error('Unexpected lesson approval')
  }
})
let proxy: RuntimeAgentSession | undefined,
  recovery = false
async function create(): Promise<RuntimeAgentSession> {
  const saved = findPhiSessionById(f.phi.sessionId)!
  return (
    await createRuntimeAgentSession({
      cwd: saved.cwd!,
      agentDir,
      model: f.model(saved.model!.modelId),
      thinkingLevel: saved.thinkingLevel,
      memory: { enabled: true, learn: true },
      projectBound: true,
      remoteProject: f.params('unused').remoteProject!,
      sessionManager: createAppRemoteSessionManager(saved.cwd!, saved.sessionId, recovery)
    })
  ).session
}
async function prompt(text: string): Promise<void> {
  const run = f.runners.startRun({
    sessionId: f.phi.sessionId,
    runId: createRunId(),
    execute: () => proxy!.prompt(text)
  })
  await run.done
  assert.equal(run.outcome, 'completed')
}
async function until(check: () => Promise<boolean>): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    assert.ok(Date.now() - start < 25000, 'actual SDK summary publication did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
try {
  proxy = await create()
  f.provider.enqueue(
    {
      tool: {
        name: 'learn',
        args: {
          memory: 'APP_LEARN_FACT: preserve exact specimen labels',
          context: 'real RPC lesson'
        }
      }
    },
    { text: 'PROJECT_A_FACT: the explicit learning conversation completed.' }
  )
  await prompt(
    'PROJECT_A_FACT: remember exact specimen labels using the approved project lesson tool'
  )
  console.log('phase real-app-checkpoint-ingested')
  const target = { agentDir, cwd: original.cwd! }
  await until(async () =>
    (await f.engine.memory.read(target)).summary.includes('PROJECT_A_SUMMARY')
  )
  const memory = await f.engine.memory.read(target)
  assert.match(memory.summary, /PROJECT_A_SUMMARY/)
  assert.equal(memory.lessons.length, 1)
  assert.match(memory.lessons[0].text, /APP_LEARN_FACT/)
  console.log('phase real-sdk-summary-visible')
  const reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!,
    count = f.provider.requests.length
  await proxy.dispose()
  recovery = true
  proxy = await create()
  assert.equal(
    f.provider.requests.length,
    count,
    'published memory restore cannot repeat the chat or summary'
  )
  assert.equal(
    findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
    reference.journalBasename
  )
  f.provider.enqueue({ text: 'Read the remembered specimen labels only on this explicit request' })
  await prompt('Use the confirmed project memory snapshot')
  const system = f.provider.requests
    .filter((request) =>
      request.messages.some(
        (message) =>
          message.role === 'user' &&
          (message.content === 'Use the confirmed project memory snapshot' ||
            (Array.isArray(message.content) &&
              message.content.length === 1 &&
              message.content[0]?.text === 'Use the confirmed project memory snapshot'))
      )
    )
    .at(-1)!
    .messages.filter((message) => message.role === 'system')
    .map((message) => JSON.stringify(message.content))
    .join('\n')
  assert.equal(system.split('PROJECT_A_SUMMARY').length - 1, 1)
  assert.equal(system.split('APP_LEARN_FACT').length - 1, 1)
  assert.match(system, /You are the assistant running in Phi/)
  assert.doesNotMatch(system, /memory:\/\/|remote-project-anchors/)
  console.log(
    JSON.stringify({
      providerRequests: f.provider.requests.length,
      lessons: memory.lessons.length,
      summaryVisible: true
    })
  )
} finally {
  await proxy?.dispose().catch(() => undefined)
  await f.close()
}
