import type { BrowserTextVault } from '../../browser/browser-text-vault'
import { createDecisionClient } from '../decision-client'
import { bindSessionDecisionEvaluator } from '../decision-evaluator'
import type { OmpBridge } from '../omp-bridge'
import type { SelectedFacadeRuntime } from './facade-session-driver'
import type { RemoteSessionRuntime } from './remote-session-runtime'
import {
  createRpcDesktopToolScope,
  type RpcDesktopToolIdentity,
  type RpcDesktopToolRun,
  type RpcDesktopToolScope
} from './desktop-tool-scope'

/** Both main and child scopes retain their original live runtime and resource ownership. */
export function createFacadeDesktopToolScopeFactory(options: {
  identity: RpcDesktopToolIdentity
  agentDir: string
  bridge: OmpBridge
  selected: SelectedFacadeRuntime
  runtime(): RemoteSessionRuntime | undefined
  vault: BrowserTextVault
}): (
  currentRun: () => RpcDesktopToolRun | undefined,
  owner?: string,
  skills?: readonly string[],
  childId?: string
) => RpcDesktopToolScope {
  const { identity, selected, runtime } = options
  const scriptTools = selected.desktopTools?.scriptTools ?? []
  const decide = bindSessionDecisionEvaluator({
    agentDir: options.agentDir,
    sessionId: identity.runtimeSessionId,
    currentModel: () => runtime()?.currentSnapshot().model,
    evaluate: createDecisionClient(options.bridge).evaluate
  })
  return (
    currentRun,
    owner = 'main',
    skills = selected.desktopTools?.allowedSkills ?? [],
    childId
  ) =>
    createRpcDesktopToolScope({
      identity,
      services: options.bridge.hostServices,
      currentRun,
      ...(owner === 'main' ? { decide } : {}),
      toolOwner: owner,
      ownsSharedResources: owner === 'main',
      assertBinding: () => {
        selected.desktopTools?.assertBinding?.()
        if (childId && !runtime()?.childRunForHost(childId))
          throw new Error('Child host scope is no longer active')
      },
      recentUserImages: selected.recentUserImages,
      allowBrowserTypeText: () => owner === 'main' && selected.desktopToolNames.includes('browser'),
      browserTextVault: childId ? runtime()!.childBrowserTextVault(childId) : options.vault,
      agentDir: options.agentDir,
      allowedSkills: skills,
      skillCatalog: selected.desktopTools?.skillCatalog,
      scriptTools,
      scriptApprovalFor: selected.desktopTools?.scriptApprovalFor
        ? (name, input) => selected.desktopTools!.scriptApprovalFor!(name, input, childId)
        : undefined,
      paletteCatalogPath: selected.desktopTools?.paletteCatalogPath,
      remoteLibrary: selected.desktopTools?.remoteLibrary,
      desktopWebSearch: selected.desktopTools?.desktopWebSearch,
      desktopMcp: selected.desktopTools?.desktopMcp,
      desktopMemory: selected.memory
    })
}
