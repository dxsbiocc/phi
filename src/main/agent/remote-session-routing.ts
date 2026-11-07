import type { Project } from './projects'
import type { SessionRunnerRegistry } from './session/session-runner-registry'
import { createRuntimeSessionManager, type RuntimeSessionManager } from './runtime/runtime-adapter'
import { phiOnlySessionPath } from './session/sessions'
import { installKernelSessionRouting } from './engine/in-process-engine'
import type { DesktopMcpAdapter } from './engine/rpc/desktop-mcp-types'
import type { RemoteStartupDiagnosticSink } from './engine/rpc/remote-startup-diagnostics'
import { resolveRemoteWorkspaceHostBinding } from './remote-workspace-boundary'
import { openRemoteRuntimeWorkspace } from './remote-runtime/workspace'
import { createAppKernelSessionLaunchers } from './app-kernel-session-launchers'

export interface AppRemoteDesktopResources {
  readonly desktopMcp?: DesktopMcpAdapter
  close?(): void | Promise<void>
}

/** Phi locators are handed to the kernel history planner, never opened as desktop journals. */
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
  startupDiagnostics?: RemoteStartupDiagnosticSink
  runners: SessionRunnerRegistry
  appPaths(): {
    appPath: string
    resourcesPath: string
    isPackaged: boolean
    version?: string
    userDataPath?: string
  }
  configuredRoot(project: Project): string
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
}

export interface AppRemoteSessionRoutingDependencies {
  resolveBinding?: typeof resolveRemoteWorkspaceHostBinding
  openWorkspace?: typeof openRemoteRuntimeWorkspace
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
