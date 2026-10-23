import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { createEnvironmentBindingExtension } from './extensions/environment-binding'
import { createNextActionInstructionExtension } from './extensions/next-action'
import { createPlanReviewToolGuardExtension } from './extensions/plan-review'
import { createProjectToolBoundaryExtension } from './extensions/project-boundary'
import { createRemoteUrlGuardExtension } from './extensions/remote-url-guard'
import { createSpecialistFallbackExtension } from './extensions/specialist-fallback'
import { createBridgeToolApprovalExtension } from './extensions/tool-approval'
import { createAutoWorkModeExtension } from './extensions/auto-work-mode'
import type { PhiExtensionConfig, PhiExtensionHost } from './host'

export type {
  PhiExtensionAgentConfig,
  PhiExtensionConfig,
  PhiExtensionEnvironmentBinding,
  PhiExtensionFallbackReadiness,
  PhiExtensionHost,
  PhiWorkMode,
  PhiPlanStepsToolResult,
  PhiExtensionToolApprovalRequest
} from './host'
export { createEnvironmentBindingExtension } from './extensions/environment-binding'
export { createNextActionInstructionExtension } from './extensions/next-action'
export { createPlanReviewToolGuardExtension } from './extensions/plan-review'
export { createPlanStepsExtension } from './extensions/plan-steps'
export { createProjectToolBoundaryExtension } from './extensions/project-boundary'
export { createRemoteUrlGuardExtension } from './extensions/remote-url-guard'
export { createSpecialistFallbackExtension } from './extensions/specialist-fallback'
export { createBridgeToolApprovalExtension } from './extensions/tool-approval'
export { createAutoWorkModeExtension, ENTER_PLAN_MODE_TOOL_NAME } from './extensions/auto-work-mode'
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
export { remoteUrlGuardDecision } from './lib/remote-url'

export function createMainSessionExtensions(
  config: PhiExtensionConfig,
  host: PhiExtensionHost
): ExtensionFactory[] {
  return [
    ...(config.workMode === 'auto' ? [createAutoWorkModeExtension(host)] : []),
    createNextActionInstructionExtension(host),
    createPlanReviewToolGuardExtension(host),
    createRemoteUrlGuardExtension(),
    ...(config.projectBound ? [createProjectToolBoundaryExtension(config.cwd)] : []),
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
    createRemoteUrlGuardExtension(),
    createPlanReviewToolGuardExtension(host),
    ...(config.enableToolApproval ? [createBridgeToolApprovalExtension(config, host)] : []),
    ...(config.environmentBinding ? [createEnvironmentBindingExtension(host)] : [])
  ]
}
