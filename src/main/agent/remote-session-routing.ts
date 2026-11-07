import type {
  RpcAgentResourceCatalogInput,
  CompileRpcAgentDefinitionsOptions
} from './engine/rpc/subagents/types'
import type { RemoteProjectConnectionState } from '../../shared/projectLocation'
import { WRAPPER_COMPOSITION_TOOL_NAMES } from './wrappers/composition/tools'
import { realpathSync } from 'node:fs'
import { NOTEBOOK_TOOL_NAMES } from './notebook/notebook-tools'
import { LIBRARY_TOOL_NAMES } from './library/library-tools'
import { createRuntimeSessionManager, type RuntimeSessionManager } from './runtime/runtime-adapter'
import { phiOnlySessionPath } from './session/sessions'
import type { PhiAgentDefinition } from './agents/definition'
import type { Project } from './projects'
import type { SessionRunnerRegistry } from './session/session-runner-registry'
import { resolveRemoteWorkspaceHostBinding } from './remote-workspace-boundary'
import { openRemoteRuntimeWorkspace } from './remote-runtime/workspace'
import { installKernelSessionRouting } from './engine/in-process-engine'
import { createAppKernelSessionLaunchers } from './app-kernel-session-launchers'
import type { SelectedFacadeRuntime } from './engine/rpc/facade-session-driver'
import { rpcToolNameExposesCredentialSurface } from './engine/phi-extension/lib/rpc-execution-protocol'
import type { RemoteOmpDeploymentOptions } from './engine/rpc/runtime-deployment'
import {
  type RemoteStartupDiagnosticSink,
  type RemoteStartupProgressEvent
} from './engine/rpc/remote-startup-diagnostics'

// The existing executor owns interruption through the captured kernel runtime and terminal ACK.
export const APP_RPC_NOTEBOOK_TOOL_NAMES = NOTEBOOK_TOOL_NAMES

export interface AppRemoteDesktopResources {
  readonly tools: NonNullable<SelectedFacadeRuntime['desktopTools']>
  readonly memory?: SelectedFacadeRuntime['memory']
  /** Retire/drain owned desktop adapters before releasing the selected SSH/workspace. */
  close?(): void | Promise<void>
}

export function appRpcDesktopToolNames(
  resources?: NonNullable<SelectedFacadeRuntime['desktopTools']>
): readonly string[] {
  const names = [
    ...APP_RPC_NOTEBOOK_TOOL_NAMES,
    ...WRAPPER_COMPOSITION_TOOL_NAMES,
    'present_files',
    'phi_decide',
    ...(resources
      ? [
          'ask_user_question',
          'render_blocks',
          'palette_suggest',
          'download_file',
          'env_request',
          'browser',
          ...(resources.allowedSkills.length ? ['skill_run'] : []),
          ...resources.scriptTools
            .filter(
              (tool) =>
                tool.attachTo.includes('main') && resources.allowedSkills.includes(tool.skill)
            )
            .map((tool) => tool.name),
          ...(resources.remoteLibrary ? LIBRARY_TOOL_NAMES : []),
          ...(resources.desktopWebSearch ? [resources.desktopWebSearch.tool.name] : []),
          ...(resources.desktopMcp?.tools.map((tool) => tool.name) ?? [])
        ]
      : [])
  ]
  if (names.some(rpcToolNameExposesCredentialSurface)) {
    throw new Error('RPC desktop tools cannot expose credential or host-setup operations')
  }
  return Object.freeze(names)
}

/** Phi locators describe remote recovery; they are never opened as desktop journal files. */
export function createAppRemoteSessionManager(
  cwd: string,
  phiSessionId: string,
  resume: boolean
): RuntimeSessionManager {
  const manager = createRuntimeSessionManager(cwd)
  if (resume) {
    manager.kind = 'open'
    manager.path = phiOnlySessionPath(phiSessionId)
  }
  return manager
}

export interface AppRemoteSessionRoutingOptions {
  /** Internal opt-in only; reports fixed names and numbers, never remote commands or paths. */
  startupDiagnostics?: RemoteStartupDiagnosticSink
  /** A previous remote run that outlived its SSH connection was stopped before this session launched. */
  onRunTakeover?(event: { sessionId: string; message: string }): void
  /** Captured main-process opt-in. Names select whole trusted profiles; never renderer definitions. */
  foregroundAgentNames?: string
  agentDir: string
  runners: SessionRunnerRegistry
  appPaths(): {
    appPath: string
    resourcesPath: string
    isPackaged: boolean
    version?: string
    userDataPath?: string
  }
  configuredRoot(project: Project): string
  loadAgents(identity: {
    sessionId: string
    projectId: string
    cwd: string
  }): Promise<readonly PhiAgentDefinition[]>
  /** Main catalog authority; renderer create parameters never supply this resource snapshot. */
  loadDesktopTools?(
    identity: {
      runtimeSessionId: string
      sessionId: string
      projectId: string
      cwd: string
      resourceCwd: string
      excludedMcpServerNames?: readonly string[]
    },
    signal: AbortSignal
  ): Promise<AppRemoteDesktopResources>
  loadPromptContext?(
    identity: {
      runtimeSessionId: string
      sessionId: string
      projectId: string
      cwd: string
      resourceCwd: string
    },
    signal: AbortSignal
  ): Promise<NonNullable<SelectedFacadeRuntime['promptContext']>>
  loadAgentResources?(
    identity: {
      runtimeSessionId: string
      sessionId: string
      projectId: string
      cwd: string
      resourceCwd: string
    },
    definitions: readonly PhiAgentDefinition[],
    signal: AbortSignal
  ): Promise<Pick<RpcAgentResourceCatalogInput, 'skills'>>
  resolveAgentEnvironment?(
    identity: {
      runtimeSessionId: string
      sessionId: string
      projectId: string
      cwd: string
      resourceCwd: string
    },
    agent: Parameters<NonNullable<CompileRpcAgentDefinitionsOptions['resolveEnvironment']>>[0],
    signal: AbortSignal
  ): ReturnType<NonNullable<CompileRpcAgentDefinitionsOptions['resolveEnvironment']>>
  onMemoryError?(identity: { sessionId: string; projectId: string }): void | Promise<void>
  approval: SelectedFacadeRuntime['approval']
  onChildApprovalEvent?: NonNullable<SelectedFacadeRuntime['foregroundChildren']>['onApprovalEvent']
}

export const E5_SMOKE_PROJECT_ID = 'e943f72e-80b4-460a-8848-d4d4da37f5ca'
const E5_SMOKE_REMOTE_ROOT = '/data2/dengxsh/phi-test'

/** A deliberately narrow development-only gate for the phi-test acceptance run. */
export function e5SmokeGate(input: {
  readonly argv: readonly string[]
  readonly devRendererUrl?: string
  readonly isDevelopment: boolean
  readonly isPackaged: boolean
  readonly agentDir: string
  readonly homeDir?: string
  readonly runtimeHomeDir: string
  readonly actualUserDataPath?: string
  readonly project: Project | undefined
}): boolean {
  if (
    input.isPackaged ||
    !input.isDevelopment ||
    !input.devRendererUrl ||
    !input.argv.includes('--e5-smoke')
  )
    return false
  if (
    input.project?.id !== E5_SMOKE_PROJECT_ID ||
    input.project.name !== 'phi-test' ||
    input.project.location.kind !== 'ssh' ||
    input.project.location.hostProfileId !== 'ssh-config:GPU' ||
    input.project.location.remoteRoot !== E5_SMOKE_REMOTE_ROOT ||
    input.project.location.canonicalRoot !== E5_SMOKE_REMOTE_ROOT
  )
    return false
  const userDataArg = input.argv.find((arg) => arg.startsWith('--user-data-dir='))
  if (!userDataArg || !input.homeDir || !input.actualUserDataPath) return false
  try {
    const agentDir = realpathSync(input.agentDir)
    const homeDir = realpathSync(input.homeDir)
    const runtimeHomeDir = realpathSync(input.runtimeHomeDir)
    const claimedUserData = realpathSync(userDataArg.slice('--user-data-dir='.length))
    const actualUserData = realpathSync(input.actualUserDataPath)
    const root = agentDir.replace(/\/home\/\.phi$/, '')
    return (
      /^\/(?:private\/)?tmp\/phi-e5-[A-Za-z0-9-]+$/.test(root) &&
      agentDir === `${root}/home/.phi` &&
      homeDir === `${root}/home` &&
      runtimeHomeDir === homeDir &&
      claimedUserData === `${root}/user-data` &&
      actualUserData === claimedUserData
    )
  } catch {
    return false
  }
}

export function selectAppForegroundAgents(
  names: readonly string[],
  catalog: readonly PhiAgentDefinition[],
  completeProfiles = false
): readonly PhiAgentDefinition[] {
  if (names.length > 32 || new Set(names).size !== names.length)
    throw new Error('RPC foreground agent names must be unique and bounded')
  const selected = names.map((name) => {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error('Invalid RPC foreground agent name')
    const matches = catalog.filter((agent) => agent.name === name)
    if (matches.length !== 1) throw new Error(`RPC foreground agent is unavailable: ${name}`)
    const agent = matches[0]
    if (
      agent.warnings.length ||
      agent.tools.includes('agent') ||
      (!completeProfiles &&
        (agent.environment !== undefined ||
          agent.skills.length ||
          agent.tools.some((tool) => !['read', 'write', 'bash'].includes(tool))))
    ) {
      throw new Error(`Unsupported RPC foreground agent profile: ${name}`)
    }
    return structuredClone(agent)
  })
  return Object.freeze(selected)
}

/** Actual main startup composition. SSH projects always use this RPC route. */
export interface AppRemoteSessionRoutingDependencies {
  resolveBinding?: typeof resolveRemoteWorkspaceHostBinding
  openWorkspace?: typeof openRemoteRuntimeWorkspace
  /** Loopback tests retain the real deployment/CLI with an offline asset, never a fake session driver. */
  deployment?: Pick<RemoteOmpDeploymentOptions, 'manifest' | 'fetchImpl' | 'uploadOptions'>
}

export function remoteStartupConnectionState(
  event: RemoteStartupProgressEvent,
  current?: RemoteProjectConnectionState,
  checkedAt = new Date().toISOString()
): RemoteProjectConnectionState | undefined {
  if ('detail' in event) {
    return {
      phase: 'connecting',
      startupProgress: event.detail,
      checkedAt
    }
  }
  if (current?.startupProgress) return { phase: 'reachable', checkedAt }
  return undefined
}

export function installAppRemoteSessionRouting(
  options: AppRemoteSessionRoutingOptions,
  dependencies: AppRemoteSessionRoutingDependencies = {}
): () => void {
  const kernelInstall = createAppKernelSessionLaunchers(options, dependencies)
  const removeKernel = installKernelSessionRouting({
    launchLocal: kernelInstall.launchLocal,
    launchRemote: kernelInstall.launchRemote,
    hostCapabilities: kernelInstall.hostCapabilities,
    configureClient: kernelInstall.configureClient,
    onDiagnostic: (error) =>
      options.startupDiagnostics?.({
        phiSessionId: 'kernel-host',
        status: 'failed',
        totalMs: 0,
        steps: [
          {
            step: `kernel_host:${error.name}`,
            durationMs: 0,
            remoteCommands: 0,
            channels: {}
          }
        ]
      })
  })
  return () => {
    removeKernel()
    void kernelInstall.close()
  }
}
