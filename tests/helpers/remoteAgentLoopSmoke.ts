// Drives a real OMP agent loop through a remote project conversation, end to end: a scripted
// model emits tool calls the way a provider does (with the harness intent field), the SDK
// validates them and runs Phi's extensions, and Phi's remote tools reach the real main-process
// handlers and the real remote skill service, which run on a local shell standing in for SSH.
// Unit tests that call a tool's execute() directly skip that loop, which is where a schema,
// guard or boundary mismatch fails every call in a real remote project.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ModelRegistry,
  SessionManager,
  Settings,
  discoverAuthStorage
} from '@oh-my-pi/pi-coding-agent'
import { createAgentSession } from '@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim'
import { initializeExtensions } from '@oh-my-pi/pi-coding-agent/modes/runtime-init'
import {
  createMockModel,
  registerMockApi,
  type MockContent,
  type MockResponse
} from '@oh-my-pi/pi-ai/providers/mock'

import { createRemoteProjectToolGuardExtension } from '../../src/main/agent/agents/remote-project-tool-guard'
import { createRemoteUrlGuardExtension } from '../../src/main/agent/agents/remote-url-guard'
import { buildScriptTools, buildSkillRunTool } from '../../src/main/agent/content/skill-tools'
import {
  buildRemoteWorkspaceCustomTools,
  buildRemoteWorkspaceRead
} from '../../src/main/agent/omp/remote-workspace-custom-tools'
import type { Project } from '../../src/main/agent/projects'
import { ensureRemoteProjectAnchor } from '../../src/main/agent/remote-project-anchor'
import { RemoteRuntimeController } from '../../src/main/agent/remote-runtime/controller'
import type { RemoteRuntimeTarget } from '../../src/main/agent/remote-runtime/workspace'
import type { PhiSessionManifest } from '../../src/main/agent/session/session-store'
import { RemoteWorkspaceBashManager } from '../../src/main/agent/remote-workspace-bash'
import {
  RemoteWorkspaceMutationManager,
  RemoteWorkspaceReadBasis
} from '../../src/main/agent/remote-workspace-edit'
import { readRemoteWorkspacePath } from '../../src/main/agent/remote-workspace-read'
import { remoteGlob, remoteGrep } from '../../src/main/agent/remote-workspace-search'
import type { RemoteWorkspaceBoundaryDependencies } from '../../src/main/agent/remote-workspace-boundary'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  writeTestSkill
} from './remoteRuntimeFixture'

const SESSION_ID = 'session-a'
const PROJECT_ID = 'project-a'
const RUNTIME_SESSION_ID = 'runtime-1'

const fixture = createRemoteRuntimeFixture()
try {
  installFakeMicromamba(fixture)
  const skill = writeTestSkill(fixture)
  const agentDir = join(fixture.root, 'phi')

  // Main process: the project registry, session manifest and host the handlers resolve.
  const location = {
    kind: 'ssh' as const,
    hostProfileId: 'host-a',
    remoteRoot: fixture.projectRoot,
    canonicalRoot: fixture.projectRoot
  }
  const project = {
    id: PROJECT_ID,
    name: 'Remote',
    location,
    workingDirectory: fixture.projectRoot,
    workingDirectoryRealPath: fixture.projectRoot,
    permissionMode: 'auto',
    pathAvailable: true,
    createdAt: '2026-10-12T00:00:00.000Z'
  } as Project
  const anchor = ensureRemoteProjectAnchor(PROJECT_ID, agentDir)
  const manifest = {
    sessionId: SESSION_ID,
    kind: 'project',
    projectId: PROJECT_ID,
    projectLocation: location,
    cwd: anchor
  } as PhiSessionManifest
  const boundary: RemoteWorkspaceBoundaryDependencies = {
    agentDir,
    getManifest: (id) => (id === SESSION_ID ? manifest : null),
    getProject: (id) => (id === PROJECT_ID ? project : undefined),
    getHostProfile: (id) =>
      id === 'host-a' ? { id, label: 'Cluster A', hostAlias: 'cluster-a' } : undefined,
    connectImpl: () => fixture.connect()
  }
  const readBasis = new RemoteWorkspaceReadBasis()
  const bashManager = new RemoteWorkspaceBashManager(boundary)
  const mutationManager = new RemoteWorkspaceMutationManager({ ...boundary, basis: readBasis })
  const runtime = new RemoteRuntimeController({
    micromambaVersion: 'test',
    resolveTarget: (params): RemoteRuntimeTarget | undefined => {
      const record = params as Record<string, unknown>
      if (record.remoteSessionId !== SESSION_ID || record.projectId !== PROJECT_ID) return undefined
      if (typeof record.runtimeSessionId !== 'string') return undefined
      return {
        runtimeSessionId: record.runtimeSessionId,
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        configuredRoot: fixture.runtimeRoot
      }
    },
    listSkills: async () => [{ ...skill, insidePlugin: false }],
    confirmEnvironment: async () => true,
    resolveBasePackages: async () => ['bash'],
    openWorkspace: async () => fixture.workspace
  })
  const remoteIdentity = { remoteSessionId: SESSION_ID, projectId: PROJECT_ID }
  const prepared = await runtime.requestEnvironment({
    requestId: 'prepare-environment',
    runtimeSessionId: RUNTIME_SESSION_ID,
    ...remoteIdentity,
    cwd: anchor,
    packages: ['coreutils'],
    reason: 'run the remote skill',
    environment: 'phi:python@1'
  })
  if (!('envId' in prepared))
    throw new Error(`environment not prepared: ${JSON.stringify(prepared)}`)

  // The worker-to-main bridge: the same method names omp-sdk-worker sends.
  const requests: Array<{ method: string; params: unknown }> = []
  const handlers: Record<string, (params: unknown) => unknown> = {
    'remoteWorkspace.read': (params) =>
      readRemoteWorkspacePath(params, {
        ...boundary,
        onFileRead: (authorized, content) =>
          readBasis.record(
            authorized.sessionId,
            authorized.projectId,
            authorized.hostAlias,
            authorized.path,
            content
          )
      }),
    'remoteWorkspace.glob': (params) => remoteGlob(params, boundary),
    'remoteWorkspace.grep': (params) => remoteGrep(params, boundary),
    'remoteWorkspace.write': (params) => mutationManager.write(params),
    'remoteWorkspace.edit': (params) => mutationManager.edit(params),
    'remoteWorkspace.cancelWrite': (params) => mutationManager.cancel(params),
    'remoteWorkspace.cancelEdit': (params) => mutationManager.cancel(params),
    'remoteWorkspace.bash': (params) => bashManager.run(params),
    'remoteWorkspace.cancelBash': (params) => bashManager.cancel(params),
    'skills.run': (params) => runtime.runSkill(params),
    'skills.scriptTool': (params) => runtime.runScriptTool(params),
    'skills.cancel': (params) => runtime.skills.cancel(params)
  }
  const requestHost = async (method: string, params: unknown): Promise<unknown> => {
    requests.push({ method, params })
    const handler = handlers[method]
    if (!handler) throw new Error(`unexpected host request ${method}`)
    return handler(params)
  }

  // Agent worker: the remote main session's tools and guards, as omp-sdk-worker builds them.
  const identity = { sessionId: SESSION_ID, projectId: PROJECT_ID }
  const remoteProject = { sessionId: SESSION_ID, projectId: PROJECT_ID }
  const listed = await runtime.scriptTools({
    runtimeSessionId: RUNTIME_SESSION_ID,
    ...remoteIdentity
  })
  const scriptTools = buildScriptTools(listed.tools, requestHost, {
    runtimeSessionId: RUNTIME_SESSION_ID,
    remoteProject
  })
  const customTools = [
    ...buildRemoteWorkspaceCustomTools(requestHost, identity, {
      read: buildRemoteWorkspaceRead(requestHost, identity),
      readResource: () => {
        throw new Error('no skill resource in this smoke test')
      }
    }),
    buildSkillRunTool(requestHost, {
      runtimeSessionId: RUNTIME_SESSION_ID,
      allowedSkills: [skill.name],
      remoteProject
    }),
    ...scriptTools
  ]
  const scriptToolNames = new Set(scriptTools.map((tool) => tool.name))

  // A model that calls every tool once, each call carrying the harness intent field.
  let callCounter = 0
  const call = (name: string, args: Record<string, unknown>): MockContent => ({
    type: 'toolCall',
    id: `call-${++callCounter}`,
    name,
    arguments: { i: `use ${name}`, ...args }
  })
  const turns: MockResponse[] = [
    { content: [call('write', { path: 'notes/a.txt', content: 'alpha\n' })] },
    { content: [call('read', { path: 'notes/a.txt' })] },
    { content: [call('edit', { path: 'notes/a.txt', old_string: 'alpha', new_string: 'beta' })] },
    {
      content: [
        call('glob', { path: '**/*.txt' }),
        call('grep', { pattern: 'beta' }),
        call('bash', { command: 'cat notes/a.txt' })
      ]
    },
    {
      content: [
        call('skill_run', { skill: skill.name, script: 'run.sh', args: ['hello'] }),
        call('remotedemo_json', { message: 'hi' })
      ]
    },
    { content: ['done'] }
  ]
  registerMockApi()
  const mock = createMockModel({ responses: turns })

  const authStorage = await discoverAuthStorage(agentDir)
  authStorage.setRuntimeApiKey('mock', 'test')
  const settings = await Settings.init({ cwd: agentDir, agentDir })
  const result = await createAgentSession({
    agentId: 'phi-remote-agent-loop-smoke',
    agentDisplayName: 'Main',
    cwd: agentDir,
    agentDir,
    settings,
    authStorage,
    modelRegistry: new ModelRegistry(authStorage),
    sessionManager: SessionManager.inMemory(agentDir),
    model: mock.model,
    customTools,
    enableMCP: false,
    enableLsp: false,
    disableExtensionDiscovery: true,
    extensions: [
      createRemoteProjectToolGuardExtension({ dynamicSkillToolNames: () => scriptToolNames }),
      createRemoteUrlGuardExtension()
    ]
  })
  await initializeExtensions(result.session, {
    reportSendError: () => undefined,
    reportRuntimeError: () => undefined
  })
  const toolResults: Array<{ toolName: string; isError: boolean; text: string }> = []
  result.session.subscribe((event) => {
    if (event.type !== 'tool_execution_end') return
    const content = (event.result as { content?: Array<{ type: string; text?: string }> })?.content
    toolResults.push({
      toolName: event.toolName,
      isError: event.isError === true,
      text: (content ?? []).map((part) => part.text ?? '').join('')
    })
  })
  await result.session.prompt('exercise every remote tool')
  await result.session.dispose()

  process.stdout.write(
    JSON.stringify({
      toolResults,
      requests: requests.map((request) => request.method),
      requestKeys: requests.map((request) => ({
        method: request.method,
        keys: Object.keys(request.params as Record<string, unknown>).sort()
      })),
      file: existsSync(join(fixture.projectRoot, 'notes', 'a.txt'))
        ? readFileSync(join(fixture.projectRoot, 'notes', 'a.txt'), 'utf8')
        : null,
      modelCalls: mock.calls.length
    }) + '\n'
  )
} finally {
  fixture.cleanup()
}
