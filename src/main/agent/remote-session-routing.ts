import type {
  RpcAgentResourceCatalogInput,
  CompileRpcAgentDefinitionsOptions
} from './engine/rpc/subagents/types'
import { WRAPPER_COMPOSITION_TOOL_NAMES } from './wrappers/composition/tools'
import { join } from 'node:path'
import { NOTEBOOK_TOOL_NAMES } from './notebook/notebook-tools'
import { LIBRARY_TOOL_NAMES } from './library/library-tools'
import { createRuntimeSessionManager, type RuntimeSessionManager } from './runtime/runtime-adapter'
import { phiOnlySessionPath } from './session/sessions'
import type { PhiAgentDefinition } from './agents/definition'
import { getProject, type Project } from './projects'
import { findPhiSessionById } from './session/session-store'
import type { SessionRunnerRegistry } from './session/session-runner-registry'
import { resolveRemoteWorkspaceHostBinding } from './remote-workspace-boundary'
import { openRemoteRuntimeWorkspace } from './remote-runtime/workspace'
import { installRemoteSessionRouting } from './engine/in-process-engine'
import { facadeBindingHash, type SelectedFacadeRuntime } from './engine/rpc/facade-session-driver'
import {
  createPhiExtensionBundle,
  resolvePhiExtensionSourceRoot
} from './engine/rpc/extension-deployment'
import type { RemoteOmpDeploymentOptions } from './engine/rpc/runtime-deployment'
import { REMOTE_OMP_MANIFEST } from './engine/rpc/runtime-deployment'

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
  return Object.freeze([
    ...APP_RPC_NOTEBOOK_TOOL_NAMES,
    ...WRAPPER_COMPOSITION_TOOL_NAMES,
    'present_files',
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
  ])
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
  enabled: boolean
  /** Captured main-process opt-in. Names select whole trusted profiles; never renderer definitions. */
  foregroundAgentNames?: string
  agentDir: string
  runners: SessionRunnerRegistry
  appPaths(): { appPath: string; resourcesPath: string; isPackaged: boolean }
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

/** Actual main startup composition; the disabled path acquires no SSH/runtime resources. */
interface AppRemoteSessionRoutingDependencies {
  resolveBinding?: typeof resolveRemoteWorkspaceHostBinding
  openWorkspace?: typeof openRemoteRuntimeWorkspace
  /** Loopback tests retain the real deployment/CLI with an offline asset, never a fake session driver. */
  deployment?: Pick<RemoteOmpDeploymentOptions, 'manifest' | 'fetchImpl' | 'uploadOptions'>
}

export function installAppRemoteSessionRouting(
  options: AppRemoteSessionRoutingOptions,
  dependencies: AppRemoteSessionRoutingDependencies = {}
): () => void {
  if (!options.enabled) return () => undefined
  const names =
    options.foregroundAgentNames
      ?.split(',')
      .map((name) => name.trim())
      .filter(Boolean) ?? []
  // Fail invalid main-owned selection before installing a route.
  if (
    names.length > 32 ||
    new Set(names).size !== names.length ||
    names.some((name) => !/^[A-Z][A-Za-z0-9]*$/.test(name))
  )
    throw new Error('Invalid RPC foreground agent selection')
  return installRemoteSessionRouting({
    enabled: true,
    runners: options.runners,
    selected: async ({ runtimeSessionId, phiSessionId, projectId }, signal) => {
      signal.throwIfAborted()
      const manifest = findPhiSessionById(phiSessionId)
      const project = getProject(projectId)
      if (
        !manifest ||
        !project ||
        project.location.kind !== 'ssh' ||
        manifest.projectId !== projectId
      )
        throw new Error('RPC runtime requires the selected Phi SSH project')
      const binding = (dependencies.resolveBinding ?? resolveRemoteWorkspaceHostBinding)({
        sessionId: phiSessionId,
        projectId
      })
      const configuredRoot = options.configuredRoot(project)
      const manifestBinding = JSON.stringify([
        manifest.cwd,
        manifest.projectLocation,
        manifest.runtimeRef?.ompSessionId,
        manifest.runtimeRef?.journalBasename
      ])
      const assertSelected = (): void => {
        signal.throwIfAborted()
        const latest = findPhiSessionById(phiSessionId)
        const currentProject = getProject(projectId)
        if (
          !latest ||
          !currentProject ||
          latest.projectId !== projectId ||
          JSON.stringify([
            latest.cwd,
            latest.projectLocation,
            latest.runtimeRef?.ompSessionId,
            latest.runtimeRef?.journalBasename
          ]) !== manifestBinding ||
          (dependencies.resolveBinding ?? resolveRemoteWorkspaceHostBinding)({
            sessionId: phiSessionId,
            projectId
          }).cacheKey !== binding.cacheKey ||
          options.configuredRoot(currentProject) !== configuredRoot
        ) {
          throw new Error('RPC selected project/host binding changed before runtime creation')
        }
      }
      assertSelected()
      const definitions = names.length
        ? selectAppForegroundAgents(
            names,
            await options.loadAgents({
              sessionId: phiSessionId,
              projectId,
              cwd: manifest.cwd
            }),
            true
          )
        : []
      assertSelected()
      const bundle = await createPhiExtensionBundle(
        resolvePhiExtensionSourceRoot(options.appPaths())
      )
      assertSelected()
      const workspace = await (dependencies.openWorkspace ?? openRemoteRuntimeWorkspace)(
        {
          runtimeSessionId,
          sessionId: phiSessionId,
          projectId,
          configuredRoot
        },
        signal
      )
      let session: Awaited<ReturnType<typeof binding.config.connect>> | undefined
      let resources: AppRemoteDesktopResources | undefined
      try {
        assertSelected()
        const promptContext = await options.loadPromptContext?.(
          {
            runtimeSessionId,
            sessionId: phiSessionId,
            projectId,
            cwd: binding.canonicalRoot,
            resourceCwd: manifest.cwd
          },
          signal
        )
        assertSelected()
        const agentIdentity = {
          runtimeSessionId,
          sessionId: phiSessionId,
          projectId,
          cwd: binding.canonicalRoot,
          resourceCwd: manifest.cwd
        }
        const agentResources = definitions.length
          ? await options.loadAgentResources?.(agentIdentity, definitions, signal)
          : undefined
        assertSelected()
        resources = await options.loadDesktopTools?.(
          {
            runtimeSessionId,
            sessionId: phiSessionId,
            projectId,
            cwd: binding.canonicalRoot,
            resourceCwd: manifest.cwd
          },
          signal
        )
        assertSelected()
        session = await binding.config.connect()
        assertSelected()
        if (
          !session.openStdio ||
          !session.openReverseTunnel ||
          !session.execWithInput ||
          !session.execBounded
        )
          throw new Error('Selected SSH transport lacks RPC process/tunnel support')
        return {
          hostProfileId: project.location.hostProfileId,
          bindingHash: facadeBindingHash(binding),
          projectId,
          projectRoot: binding.canonicalRoot,
          runtime: {
            runtimeHost: workspace.runtimeHost,
            runtimeRoot: workspace.runtimeRoot,
            desktopVersion: REMOTE_OMP_MANIFEST.version,
            cacheDir: join(options.agentDir, 'cache', 'omp'),
            ...dependencies.deployment
          },
          session,
          bundle,
          recovery: manifest.runtimeRef ? 'resume' : 'new',
          approval: { ...options.approval, projectName: project.name },
          desktopToolNames: appRpcDesktopToolNames(resources?.tools),
          desktopTools: resources?.tools,
          memory: resources?.memory,
          onMemoryError: () => options.onMemoryError?.({ sessionId: phiSessionId, projectId }),
          ...(promptContext ? { promptContext } : {}),
          recentUserImages: () => [],
          ...(definitions.length
            ? { nativeTools: ['read', 'write', 'edit', 'bash', 'glob', 'grep'] as const }
            : {}),
          ...(definitions.length
            ? {
                foregroundChildren: {
                  definitions,
                  allowParallel: true,
                  allowBackground: true,
                  ...(agentResources ? { resources: agentResources } : {}),
                  ...(options.resolveAgentEnvironment
                    ? {
                        resolveEnvironment: (
                          agent: Parameters<
                            NonNullable<CompileRpcAgentDefinitionsOptions['resolveEnvironment']>
                          >[0]
                        ) => {
                          assertSelected()
                          return options.resolveAgentEnvironment!(agentIdentity, agent, signal)
                        }
                      }
                    : {}),
                  onApprovalEvent: options.onChildApprovalEvent
                }
              }
            : {}),
          dispose: async () => {
            await Promise.resolve()
              .then(() => resources?.close?.())
              .catch(() => undefined)
            await Promise.allSettled([session!.close(), workspace.close?.()])
          }
        }
      } catch (error) {
        await Promise.resolve()
          .then(() => resources?.close?.())
          .catch(() => undefined)
        await Promise.allSettled([session?.close(), workspace.close?.()])
        throw error
      }
    }
  })
}
