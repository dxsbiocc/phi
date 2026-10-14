import { join } from 'node:path'
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
  approval: SelectedFacadeRuntime['approval']
  onChildApprovalEvent?: NonNullable<SelectedFacadeRuntime['foregroundChildren']>['onApprovalEvent']
}

export function selectAppForegroundAgents(
  names: readonly string[],
  catalog: readonly PhiAgentDefinition[]
): readonly PhiAgentDefinition[] {
  if (names.length > 32 || new Set(names).size !== names.length)
    throw new Error('RPC foreground agent names must be unique and bounded')
  const selected = names.map((name) => {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error('Invalid RPC foreground agent name')
    const matches = catalog.filter((agent) => agent.name === name)
    if (matches.length !== 1) throw new Error(`RPC foreground agent is unavailable: ${name}`)
    const agent = matches[0]
    if (
      agent.environment !== undefined ||
      agent.skills.length ||
      agent.warnings.length ||
      agent.tools.some((tool) => !['read', 'write', 'bash'].includes(tool))
    )
      throw new Error(`Unsupported RPC foreground agent profile: ${name}`)
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
      const definitions = names.length
        ? selectAppForegroundAgents(
            names,
            await options.loadAgents({
              sessionId: phiSessionId,
              projectId,
              cwd: manifest.cwd
            })
          )
        : []
      const bundle = await createPhiExtensionBundle(
        resolvePhiExtensionSourceRoot(options.appPaths())
      )
      signal.throwIfAborted()
      const workspace = await (dependencies.openWorkspace ?? openRemoteRuntimeWorkspace)(
        {
          runtimeSessionId,
          sessionId: phiSessionId,
          projectId,
          configuredRoot: options.configuredRoot(project)
        },
        signal
      )
      let session: Awaited<ReturnType<typeof binding.config.connect>> | undefined
      try {
        signal.throwIfAborted()
        session = await binding.config.connect()
        signal.throwIfAborted()
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
          desktopToolNames: [],
          recentUserImages: () => [],
          ...(definitions.length
            ? { foregroundChildren: { definitions, onApprovalEvent: options.onChildApprovalEvent } }
            : {}),
          dispose: async () => {
            await Promise.allSettled([session!.close(), workspace.close?.()])
          }
        }
      } catch (error) {
        await Promise.allSettled([session?.close(), workspace.close?.()])
        throw error
      }
    }
  })
}
