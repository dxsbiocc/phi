import { startHostResultModel, type ModelReply } from './rpcHostResultModel'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { facadeMetadataFixture } from './facadeMetadataFixture'
import { desktopMcpFixture } from './desktopMcpFixture'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  readFakeMicromambaInvocations,
  writeTestSkill
} from './remoteRuntimeFixture'
import { RemoteRuntimeController } from '../../src/main/agent/remote-runtime/controller'
import { SshHost } from '../../src/main/agent/workspace-host/ssh-host'
import { createRemoteRuntimeInputExec } from '../../src/main/agent/remote-runtime/input-exec'
import { resolveRemoteWorkspaceHostBinding } from '../../src/main/agent/remote-workspace-boundary'
import { facadeBindingHash } from '../../src/main/agent/engine/rpc/facade-session-driver'
import {
  createRunId,
  findPhiSessionById,
  readSessionEvents
} from '../../src/main/agent/session/session-store'
import type { PhiAgentDefinition } from '../../src/main/agent/agents/definition'
import type { PhiHostRequestContext } from '../../src/main/agent/engine/types'
import type { AppRemoteSessionRoutingOptions } from '../../src/main/agent/remote-session-routing'
import type { RpcChildRuntimeConfig } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'

type Identity = Parameters<NonNullable<AppRemoteSessionRoutingOptions['loadDesktopTools']>>[0]
const mcp = await desktopMcpFixture()
const identities = new Map<string, Identity>()
const definition: PhiAgentDefinition = {
  name: 'Research',
  description: 'Use the trusted scientific fixture',
  source: 'phi',
  filePath: '/trusted/Research.md',
  visibility: 'entry',
  warnings: [],
  systemPrompt: 'TRUSTED_RESOURCE_EXPERT',
  tools: [
    'bash',
    'remotedemo_json',
    'remotedemo_write',
    'skill_run',
    'render_blocks',
    'mcp__fixture_inspect'
  ],
  skills: ['remote-demo'],
  environment: 'phi:python@1',
  model: ['phi-facade-regression/model-b'],
  thinkingLevel: 'off'
}
const f = await facadeMetadataFixture({
  isolatedProject: true,
  providerFactory: async () => {
    const parent: ModelReply[] = [],
      child: ModelReply[] = []
    const provider = await startHostResultModel({
      replyFor: (request) => {
        const tools = (request.tools as Array<{ function: { name: string } }>).map(
          (tool) => tool.function.name
        )
        if (tools.includes('task')) {
          return parent.shift()
        }
        if (
          request.model === 'model-b' &&
          JSON.stringify([...tools].sort()) === JSON.stringify([...definition.tools].sort())
        ) {
          return child.shift()
        }
        throw new Error('Resource fixture received an unexpected model/tool actor')
      }
    })
    return {
      ...provider,
      enqueue: (...replies: ModelReply[]) => {
        assert.equal(replies.length, 9)
        parent.push(replies[0], replies[8])
        child.push(...replies.slice(1, 8))
      }
    }
  },
  applicationRouting: {
    foregroundAgentNames: 'Research',
    agents: [definition],
    loadDesktopTools: async (identity, signal) => {
      identities.set(identity.runtimeSessionId, identity)
      const request = {
        runtimeSessionId: identity.runtimeSessionId,
        remoteSessionId: identity.sessionId,
        projectId: identity.projectId
      }
      const prepared = await runtime.requestEnvironment({
        ...request,
        requestId: 'fixture-seed',
        environment: 'phi:python@1',
        packages: ['coreutils'],
        reason: 'isolated deterministic fixture, no download'
      })
      assert.ok('envId' in prepared, JSON.stringify(prepared))
      const listed = await runtime.scriptTools(request)
      assert.deepEqual(listed.problems, [])
      const adapter = await mcp.adapter({ identity, signal })
      return {
        tools: {
          allowedSkills: ['remote-demo'],
          skillCatalog: [{ name: 'remote-demo', description: 'TRUSTED_SKILL_CONTENT_RESOURCE' }],
          scriptTools: listed.tools,
          paletteCatalogPath: join(process.cwd(), 'resources/palettes/palettes.yaml'),
          desktopMcp: adapter,
          scriptApprovalFor: (name, input, childId) =>
            runtime.approvalFor(
              name,
              input,
              childId
                ? control(identity, {
                    originSessionId: identity.runtimeSessionId,
                    agentRunId: childId,
                    signal
                  })
                : undefined
            )
        },
        close: () => adapter.close()
      }
    },
    loadAgentResources: async () => ({
      skills: [
        {
          name: source.name,
          description: 'TRUSTED_SKILL_CONTENT_RESOURCE',
          markdown: readFileSync(source.filePath, 'utf8')
        }
      ]
    }),
    resolveAgentEnvironment: async (identity, agent, signal) => {
      const descriptor = await runtime.environments.describeReadyInWorkspace(
        agent.environment!,
        serverWorkspace,
        signal
      )
      assert.ok(descriptor?.execution)
      const binding = resolveRemoteWorkspaceHostBinding({
        sessionId: identity.sessionId,
        projectId: identity.projectId
      })
      return {
        ...descriptor,
        binding: {
          serverId: JSON.parse(binding.cacheKey)[0],
          serverIdentitySha256: facadeBindingHash(binding),
          projectId: identity.projectId,
          projectRoot: identity.cwd
        }
      }
    }
  }
})
const server = createRemoteRuntimeFixture()
const envFixture = { ...server, projectRoot: f.f.scope.projectRoot, runtimeRoot: f.f.runtimeRoot }
const binary = installFakeMicromamba(envFixture)
const source = writeTestSkill(server)
writeFileSync(
  source.filePath,
  readFileSync(source.filePath, 'utf8').replace(
    '  toolPrefix:',
    '  attachTo: [Research]\n  toolPrefix:'
  ) + '\nTRUSTED_SKILL_CONTENT_RESOURCE\n'
)
await writeFile(join(f.f.runtimeRoot, 'micromamba-invocations.log'), '')
const host = new SshHost({
  remoteRoot: f.f.scope.projectRoot,
  canonicalRoot: f.f.scope.projectRoot,
  connect: async () => ({ ...f.f.session, ...f.hostSession, close: async () => undefined })
})
const serverWorkspace = {
  projectHost: host,
  runtimeHost: f.f.host,
  projectRoot: f.f.scope.projectRoot,
  runtimeRoot: f.f.runtimeRoot,
  micromambaPath: binary,
  execWithInput: createRemoteRuntimeInputExec(async () => ({
    ...f.f.session,
    ...f.hostSession,
    close: async () => undefined
  }))
}
const runtime = new RemoteRuntimeController({
  micromambaVersion: 'test',
  resolveTarget: (raw) => {
    const input = raw as Record<string, unknown>,
      identity = identities.get(String(input.runtimeSessionId))
    return identity &&
      input.remoteSessionId === identity.sessionId &&
      input.projectId === identity.projectId
      ? {
          runtimeSessionId: identity.runtimeSessionId,
          sessionId: identity.sessionId,
          projectId: identity.projectId,
          configuredRoot: f.f.runtimeRoot
        }
      : undefined
  },
  listSkills: async () => [{ ...source, insidePlugin: false }],
  resolveBasePackages: async () => ['bash'],
  confirmEnvironment: async () => true,
  openWorkspace: async () => serverWorkspace
})
function control(
  identity: Identity,
  context: PhiHostRequestContext
): import('../../src/main/agent/remote-runtime/controller').RemoteRuntimeDispatchControl {
  const binding = resolveRemoteWorkspaceHostBinding({
    sessionId: identity.sessionId,
    projectId: identity.projectId
  }).cacheKey
  const owner = context.agentRunId
    ? f.engine.agentRuns.resourceOwner?.(identity.runtimeSessionId, context.agentRunId)
    : undefined
  if (context.agentRunId) assert.ok(owner, 'actual verified child resource owner required')
  return {
    signal: context.signal,
    beforeDispatch: () => {
      context.signal?.throwIfAborted()
      assert.equal(
        resolveRemoteWorkspaceHostBinding({
          sessionId: identity.sessionId,
          projectId: identity.projectId
        }).cacheKey,
        binding
      )
      if (context.agentRunId)
        assert.deepEqual(
          f.engine.agentRuns.resourceOwner?.(identity.runtimeSessionId, context.agentRunId),
          owner
        )
    },
    ...(owner ? { resourceOwner: owner } : {})
  }
}
for (const [method, execute] of [
  ['skills.run', runtime.runSkill.bind(runtime)],
  ['skills.scriptTool', runtime.runScriptTool.bind(runtime)]
] as const)
  f.engine.host.register(method, (params, context) => {
    const identity = identities.get(String((params as Record<string, unknown>).runtimeSessionId))!
    assert.equal(context.originSessionId, identity.runtimeSessionId)
    return execute(params, control(identity, context))
  })
f.engine.host.register('skills.cancel', (params) => runtime.skills.cancel(params))
let cleanupFailure: unknown
let proxy: Awaited<ReturnType<typeof f.createApplicationSession>>['session'] | undefined
try {
  const approvals: string[] = []
  f.configureApproval({
    shouldGate: () => true,
    requestToolApproval: (request) => {
      approvals.push(request.toolName)
      if (request.toolName === 'bash') assert.match(request.summary ?? '', /micromamba/)
      return 'approved'
    }
  })
  proxy = (await f.createApplicationSession()).session
  console.log('Resource app selection and genuine CLI adoption confirmed')
  const directories = await f.privateDirectories()
  const config = JSON.parse(
    await readFile(join(directories[0], 'child-runtime.json'), 'utf8')
  ) as RpcChildRuntimeConfig
  const profile = config.profiles.find((item) => item.definition.blocking)!
  assert.ok(profile.definition.resourcesDigest && profile.effectivePromptDigest)
  assert.equal(config.resources?.skills.length, 1)
  const large = 'CHILD_HOST_LARGE_'.repeat(400)
  f.provider.enqueue(
    {
      tool: {
        name: 'task',
        args: {
          context: 'Trusted independent scientific task',
          tasks: [
            {
              agent: profile.definition.nativeName,
              task: 'Use the exact trusted resources once',
              solutionSpace: 'Only fixture resources'
            }
          ]
        },
        id: 'resource-task'
      }
    },
    {
      tool: {
        name: 'bash',
        args: {
          command: `printf CHILD_MANAGED_BASH > '${join(f.f.scope.projectRoot, 'child-managed.txt')}'`
        },
        id: 'resource-bash'
      }
    },
    { tool: { name: 'remotedemo_json', args: { message: large }, id: 'resource-large' } },
    {
      tool: {
        name: 'remotedemo_write',
        args: { output: 'child-script.txt', content: 'CHILD_DECLARED_SCRIPT' },
        id: 'resource-write'
      }
    },
    {
      tool: {
        name: 'skill_run',
        args: { skill: 'remote-demo', script: 'run.sh', args: ['child-argument'] },
        id: 'resource-skill'
      }
    },
    {
      tool: {
        name: 'render_blocks',
        args: {
          blocks: [
            { type: 'table', columns: [{ key: 'value', label: 'Value' }], rows: [{ value: null }] }
          ]
        },
        id: 'resource-blocks'
      }
    },
    { tool: { name: 'mcp__fixture_inspect', args: { operation: 'image' }, id: 'resource-image' } },
    { text: 'Child resources complete' },
    { text: 'Parent reports verified child completion' }
  )
  const run = f.runners.startRun({
    sessionId: f.phi.sessionId,
    runId: createRunId(),
    execute: async () => {
      try {
        await proxy!.prompt('Delegate one resource-bound scientific task')
      } catch (error) {
        console.error(
          'Resource original prompt failure',
          error instanceof Error ? error.message : String(error)
        )
        throw error
      }
    }
  })
  await run.done
  console.log(
    'Resource expert terminal captured',
    run.outcome,
    'providerCount',
    f.provider.requests.length,
    'approvalNames',
    JSON.stringify(approvals)
  )
  if (run.outcome !== 'completed')
    console.error(
      'Resource preceding model tool results',
      JSON.stringify(
        f.provider.requests.at(-1)?.messages.filter((message) => message.role === 'tool')
      ).slice(0, 5000)
    )
  assert.equal(run.outcome, 'completed')
  assert.equal(
    await readFile(join(f.f.scope.projectRoot, 'child-managed.txt'), 'utf8'),
    'CHILD_MANAGED_BASH'
  )
  assert.equal(
    await readFile(join(f.f.scope.projectRoot, 'child-script.txt'), 'utf8'),
    'CHILD_DECLARED_SCRIPT'
  )
  assert.equal(await f.exists(join(f.phi.manifest.cwd, 'child-managed.txt')), false)
  assert.equal(await f.exists(join(f.phi.manifest.cwd, 'child-script.txt')), false)
  assert.equal(f.provider.requests.length, 9)
  const childRequests = f.provider.requests.slice(1, -1)
  assert.ok(childRequests.every((request) => request.model === 'model-b'))
  const system = childRequests[0].messages
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content))
    .join('\n')
  assert.equal(
    system.split('TRUSTED_SKILL_CONTENT_RESOURCE').length - 1,
    1,
    'real trusted SKILL body is injected once'
  )
  assert.ok(childRequests.some((request) => JSON.stringify(request.messages).includes(large)))
  assert.deepEqual(
    [...approvals].sort(),
    ['bash', 'mcp__fixture_inspect', 'remotedemo_write', 'skill_run'].sort()
  )
  assert.equal(mcp.requests.filter((request) => request.method === 'tools/call').length, 1)
  const journals = await readdir(f.f.runtimeRoot, { recursive: true })
  const messages: Array<Record<string, unknown>> = []
  for (const path of journals.filter((path) => path.endsWith('.jsonl'))) {
    for (const line of (await readFile(join(f.f.runtimeRoot, path), 'utf8'))
      .split('\n')
      .filter(Boolean)) {
      const entry = JSON.parse(line)
      if (entry.message) messages.push(entry.message)
    }
  }
  const image = messages.find((message) => message.toolCallId === 'resource-image')!
  assert.ok(image)
  assert.ok((image.content as Array<{ type: string }>).some((part) => part.type === 'image'))
  assert.ok(image.details)
  const blocks = messages.find((message) => message.toolCallId === 'resource-blocks')!
  assert.deepEqual((blocks.details as { blocks: Array<{ rows: unknown[] }> }).blocks[0].rows, [
    { value: null }
  ])
  const events = readSessionEvents(f.phi.sessionId)
  assert.equal(events.filter((event) => event.type === 'approval_requested').length, 4)
  assert.equal(events.filter((event) => event.type === 'approval_approved').length, 4)
  const before = readFakeMicromambaInvocations(envFixture),
    reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
  await proxy.dispose()
  f.resume()
  proxy = (await f.createApplicationSession()).session
  assert.equal(f.provider.requests.length, 9)
  assert.deepEqual(
    readFakeMicromambaInvocations(envFixture).filter((item) => item.argv.includes('run')),
    before.filter((item) => item.argv.includes('run'))
  )
  assert.equal(
    findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
    reference.journalBasename
  )
  console.log(
    'Actual app child: independent model, trusted skill body, managed bash, real declared scripts, >4KiB host result, MCP image/details and null UI data; same journal restore without replay'
  )
} finally {
  await proxy?.dispose().catch(() => undefined)
  const cleanup = await Promise.allSettled([
    f.close(),
    host.close(),
    ...server.sessions.map((session) => session.close()),
    mcp.close()
  ])
  server.cleanup()
  const failure = cleanup.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') cleanupFailure = failure.reason
}

if (cleanupFailure) throw cleanupFailure
