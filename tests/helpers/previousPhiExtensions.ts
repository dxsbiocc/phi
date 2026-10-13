import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, posix, resolve } from 'node:path'

import ts from 'typescript'

import type {
  PhiExtensionConfig,
  PhiExtensionHost,
  createMainSessionExtensions
} from '../../src/main/agent/engine/phi-extension'

type Factory = ReturnType<typeof createMainSessionExtensions>[number]
type OldModule = Record<string, unknown>
type OldFactory = (...args: unknown[]) => Factory

// Frozen old bodies and pure dependencies, extracted directly from d422a51b.
// Worker IPC is the sole substituted live service; no current extension factory
// or decision helper is used by this oracle.
const snapshot = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../fixtures/phi-extension-pre-t6/sources.json'),
    'utf8'
  )
) as { commit: string; modules: Record<string, string> }
assert.equal(snapshot.commit, 'd422a51b')
const nativeRequire = createRequire(import.meta.url)

export function previousExtensions(
  config: PhiExtensionConfig,
  host: PhiExtensionHost
): {
  main: Factory[]
  specialist: Factory[]
  remoteGuard: OldFactory
} {
  const cache = new Map<string, OldModule>()
  function load(path: string): OldModule {
    const cached = cache.get(path)
    if (cached) return cached
    const source = snapshot.modules[path]
    assert.ok(source, `Missing frozen pre-T6 module ${path}`)
    const exports: OldModule = {}
    cache.set(path, exports)
    const injected = {
      isRecord: (value: unknown) =>
        typeof value === 'object' && value !== null && !Array.isArray(value),
      requestToolApproval: (
        sessionId: string,
        event: { toolCallId: string; toolName: string; input: unknown },
        agentRunId?: string
      ) => host.requestToolApproval({ sessionId, ...event, ...(agentRunId ? { agentRunId } : {}) }),
      ...(path.endsWith('/tool-support.ts')
        ? {
            planModeToolDecision: load('src/main/agent/plan/plan-tool-policy.ts')
              .planModeToolDecision
          }
        : {})
    }
    const output = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText
    const requireOld = (specifier: string): unknown => {
      if (specifier.startsWith('node:')) return nativeRequire(specifier)
      assert.ok(specifier.startsWith('.'), `Unexpected old dependency ${path} -> ${specifier}`)
      return load(`${posix.normalize(posix.join(dirname(path), specifier))}.ts`)
    }
    new Function('require', 'exports', ...Object.keys(injected), output)(
      requireOld,
      exports,
      ...Object.values(injected)
    )
    return exports
  }
  const named = (path: string, name: string): OldFactory => {
    const factory = load(`src/main/agent/${path}.ts`)[name]
    assert.equal(typeof factory, 'function', `Missing old factory ${name}`)
    return factory as OldFactory
  }
  const old = {
    createNextActionInstructionExtension: named(
      'engine/next-action-extension',
      'createNextActionInstructionExtension'
    ),
    createPlanReviewToolGuardExtension: named(
      'engine/in-process/tool-support',
      'createPlanReviewToolGuardExtension'
    ),
    createBridgeToolApprovalExtension: named(
      'engine/in-process/tool-support',
      'createBridgeToolApprovalExtension'
    ),
    createRemoteProjectToolGuardExtension: named(
      'agents/remote-project-tool-guard',
      'createRemoteProjectToolGuardExtension'
    ),
    createRemoteUrlGuardExtension: named(
      'agents/remote-url-guard',
      'createRemoteUrlGuardExtension'
    ),
    createProjectToolBoundaryExtension: named(
      'agents/project-tool-boundary',
      'createProjectToolBoundaryExtension'
    ),
    createSpecialistFallbackExtension: named(
      'agents/fallback-policy',
      'createSpecialistFallbackExtension'
    ),
    createEnvironmentBindingExtension: named(
      'agents/environment-binding',
      'createEnvironmentBindingExtension'
    )
  }
  const parent = (): { session: { getPlanModeState: () => { enabled: boolean } } } => ({
    session: { getPlanModeState: () => ({ enabled: host.planModeActive() }) }
  })
  const mainSource = snapshot.modules['src/main/agent/engine/in-process/session-creation.ts']
  const mainOutput = ts.transpileModule(mainSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const mainExports: { extensionFactories?: Factory[] } = {}
  const mainValues = {
    ...old,
    requestHost: () => host.nextActionSuggestionsEnabled(),
    parentRef: { current: parent() },
    remoteRoot: config.remote ? '/remote/project' : undefined,
    remoteSkillToolNames: host.remoteSkillToolNames(),
    phiAgents: config.phiAgents,
    agentDelegationToolDescription: (agent: { name: string }) =>
      host.remoteAgentToolDescriptions().get(agent.name),
    cwd: config.cwd,
    remoteMcpAccess: {
      get state() {
        return host.remoteMcpToolState()
      }
    },
    record: config,
    agentRuns: { fallbackReadiness: host.fallbackReadiness },
    sessionId: config.sessionId,
    browserTextVault: config.useBrowserTextVault
      ? { approvalInput: host.browserApprovalInput, markDenied: host.markBrowserTextDenied }
      : undefined
  }
  new Function('exports', ...Object.keys(mainValues), mainOutput)(
    mainExports,
    ...Object.values(mainValues)
  )
  const specialistSource = snapshot.modules['src/main/agent/engine/in-process/subagents.ts']
  const specialistOutput = ts.transpileModule(specialistSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const specialistExports: { specialistToolCallFactories?: (...args: unknown[]) => Factory[] } = {}
  new Function('exports', ...Object.keys(old), specialistOutput)(
    specialistExports,
    ...Object.values(old)
  )
  const binding = config.environmentBinding
    ? {
        ...config.environmentBinding,
        get hostEnv() {
          return host.hostEnvironment()
        }
      }
    : undefined
  assert.ok(mainExports.extensionFactories)
  assert.ok(specialistExports.specialistToolCallFactories)
  return {
    main: mainExports.extensionFactories,
    specialist: specialistExports.specialistToolCallFactories(
      {
        sessionId: config.sessionId,
        agentRunId: config.agentRunId,
        remoteRoot: config.remote ? '/remote/project' : undefined,
        enableToolApproval: config.enableToolApproval,
        skillTools: [...host.remoteSkillToolNames()].map((name) => ({ name })),
        remoteMcpToolState: host.remoteMcpToolState,
        parent
      },
      binding
    ),
    remoteGuard: old.createRemoteProjectToolGuardExtension
  }
}
