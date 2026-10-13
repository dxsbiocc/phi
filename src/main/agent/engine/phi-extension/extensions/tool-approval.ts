import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import type { PhiExtensionConfig, PhiExtensionHost } from '../host'
import { isRecord } from '../lib/common'

export function createBridgeToolApprovalExtension(
  config: PhiExtensionConfig,
  host: PhiExtensionHost
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const browserTypeText =
        config.useBrowserTextVault &&
        event.toolName === 'browser' &&
        isRecord(event.input) &&
        event.input.action === 'typeText'
      const result = await host.requestToolApproval({
        sessionId: config.sessionId,
        ...(config.agentRunId ? { agentRunId: config.agentRunId } : {}),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input
      })
      if (browserTypeText) {
        const input = host.browserApprovalInput(event.toolCallId, event.input)
        if (isRecord(result) && result.block === true) {
          host.markBrowserTextDenied(event.toolCallId)
          return result
        }
        return { input }
      }
      return result === null ? undefined : result
    })
  }
}
