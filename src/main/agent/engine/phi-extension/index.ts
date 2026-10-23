import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { createEnvironmentBindingExtension } from './extensions/environment-binding'
import { createNextActionInstructionExtension } from './extensions/next-action'
import { createPlanReviewToolGuardExtension } from './extensions/plan-review'
import { createProjectToolBoundaryExtension } from './extensions/project-boundary'
import { createRemoteProjectToolGuardExtension } from './extensions/remote-project-guard'
import { createRemoteUrlGuardExtension } from './extensions/remote-url-guard'
import { createSpecialistFallbackExtension } from './extensions/specialist-fallback'
import { createBridgeToolApprovalExtension } from './extensions/tool-approval'
import type { PhiExtensionConfig, PhiExtensionHost } from './host'

export type {
  PhiExtensionAgentConfig,
  PhiExtensionConfig,
  PhiExtensionEnvironmentBinding,
  PhiExtensionFallbackReadiness,
  PhiExtensionHost,
  PhiPlanStepsToolResult,
  PhiExtensionToolApprovalRequest,
  PhiRemoteMcpGuardState
} from './host'
export { createEnvironmentBindingExtension } from './extensions/environment-binding'
export { createNextActionInstructionExtension } from './extensions/next-action'
export { createPlanReviewToolGuardExtension } from './extensions/plan-review'
export { createPlanStepsExtension } from './extensions/plan-steps'
export { createProjectToolBoundaryExtension } from './extensions/project-boundary'
export { createRemoteProjectToolGuardExtension } from './extensions/remote-project-guard'
export { createRemoteUrlGuardExtension } from './extensions/remote-url-guard'
export { createSpecialistFallbackExtension } from './extensions/specialist-fallback'
export { createBridgeToolApprovalExtension } from './extensions/tool-approval'
export {
  isReservedExecutionName,
  reduceToolCallResults,
  rewriteBoundBashInput
} from './lib/environment'
export type { EnvironmentBinding, ToolCallRewrite } from './lib/environment'
export { evaluateSpecialistFallback } from './lib/fallback'
export type { SpecialistFallbackDecision, SpecialistToolCall } from './lib/fallback'
export { planModeToolDecision } from './lib/plan-mode'
export { projectToolBoundaryDecision } from './lib/project-boundary'
export { resolveInsideProject } from './lib/project-path'
export {
  REMOTE_MCP_PROJECT_DEPENDENCY_REASON,
  REMOTE_MCP_UNVERIFIED_REASON,
  remoteMcpInputUsesLocalProject,
  remoteMcpToolCallReason
} from './lib/remote-mcp'
export {
  REMOTE_TOOLS_PENDING_REASON,
  REMOTE_WORKSPACE_TOOL_DESCRIPTIONS,
  remoteAgentSupportedToolNames,
  remoteAgentToolRegistrationVerified,
  remoteProjectToolDecision,
  remoteWorkspaceToolsVerified
} from './lib/remote-project-policy'
export type { RemoteProjectToolInfo } from './lib/remote-project-policy'
export {
  NOTEBOOK_TOOL_DESCRIPTIONS,
  PHI_ENV_REQUEST_DESCRIPTION,
  PHI_LEARN_DESCRIPTION,
  PHI_REMOTE_BASH_DESCRIPTION,
  PHI_REMOTE_DOWNLOAD_DESCRIPTION,
  PHI_REMOTE_EDIT_DESCRIPTION,
  PHI_REMOTE_GLOB_DESCRIPTION,
  PHI_REMOTE_GREP_DESCRIPTION,
  PHI_REMOTE_PRESENT_FILES_DESCRIPTION,
  PHI_REMOTE_READ_DESCRIPTION,
  PHI_REMOTE_WRITE_DESCRIPTION,
  PHI_SKILL_RUN_DESCRIPTION
} from './lib/remote-tool-descriptions'
export { remoteUrlGuardDecision } from './lib/remote-url'

export function createMainSessionExtensions(
  config: PhiExtensionConfig,
  host: PhiExtensionHost
): ExtensionFactory[] {
  return [
    createNextActionInstructionExtension(host),
    createPlanReviewToolGuardExtension(host),
    ...(config.remote
      ? [
          createRemoteProjectToolGuardExtension({
            dynamicSkillToolNames: () => host.remoteSkillToolNames(),
            dynamicAgentToolNames: () => new Set(host.remoteAgentToolDescriptions().keys()),
            dynamicAgentToolDescriptions: () => host.remoteAgentToolDescriptions(),
            remoteMcpToolState: () => host.remoteMcpToolState()
          })
        ]
      : []),
    createRemoteUrlGuardExtension(),
    ...(config.projectBound && !config.remote
      ? [createProjectToolBoundaryExtension(config.cwd)]
      : []),
    ...(config.phiAgents.length > 0
      ? [createSpecialistFallbackExtension(config.phiAgents, host)]
      : []),
    ...(config.enableToolApproval ? [createBridgeToolApprovalExtension(config, host)] : [])
  ]
}

export function createSpecialistExtensions(
  config: PhiExtensionConfig,
  host: PhiExtensionHost
): ExtensionFactory[] {
  return [
    ...(config.remote
      ? [
          createRemoteProjectToolGuardExtension({
            dynamicSkillToolNames: () => host.remoteSkillToolNames(),
            dynamicAgentToolNames: () => new Set(host.remoteAgentToolDescriptions().keys()),
            dynamicAgentToolDescriptions: () => host.remoteAgentToolDescriptions(),
            remoteMcpToolState: () => host.remoteMcpToolState()
          })
        ]
      : []),
    createRemoteUrlGuardExtension(),
    createPlanReviewToolGuardExtension(host),
    ...(config.enableToolApproval ? [createBridgeToolApprovalExtension(config, host)] : []),
    ...(config.environmentBinding ? [createEnvironmentBindingExtension(host)] : [])
  ]
}
