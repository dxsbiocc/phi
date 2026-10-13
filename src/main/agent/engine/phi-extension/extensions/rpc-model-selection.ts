import { realpathSync } from 'node:fs'
import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import {
  parseRpcModelSelectionRequest,
  RPC_MODEL_SELECTION_COMMAND,
  RPC_MODEL_SELECTION_DESCRIPTION,
  type RpcModelMetadata,
  type RpcModelSelectionNotification
} from '../lib/rpc-model-metadata'

/** YAML needs numeric bootstrap limits; this public runtime seam restores trusted unknown limits. */
export function createRpcModelSelectionExtension(metadata: RpcModelMetadata): ExtensionFactory {
  return (pi) => {
    let selecting = false
    pi.registerCommand(RPC_MODEL_SELECTION_COMMAND, {
      description: RPC_MODEL_SELECTION_DESCRIPTION,
      handler: async (args, ctx) => {
        const request = parseRpcModelSelectionRequest(args, metadata)
        if (realpathSync(ctx.cwd) !== metadata.projectRoot || !ctx.isIdle() || selecting)
          throw new Error('Phi RPC model selection requires the owned idle project')
        const safe = metadata.models.find(
          (model) => model.provider === request.provider && model.id === request.modelId
        )
        // Registry.find supports aliases; exact available identities must bind this selection.
        const native = ctx.modelRegistry
          .getAvailable()
          .find((model) => model.provider === request.provider && model.id === request.modelId)
        if (!safe || !native || native.transport !== 'pi-native')
          throw new Error('Phi RPC model selection is unavailable')
        selecting = true
        try {
          const selected = await pi.setModel({
            ...native,
            contextWindow: safe.contextWindow,
            maxTokens: safe.maxTokens
          })
          // Command contexts spread the original model getter into a snapshot.
          const actual = ctx.models.current()
          if (
            !selected ||
            !actual ||
            actual.provider !== safe.provider ||
            actual.id !== safe.id ||
            actual.contextWindow !== safe.contextWindow ||
            actual.maxTokens !== safe.maxTokens ||
            actual.transport !== native.transport ||
            actual.baseUrl !== native.baseUrl
          )
            throw new Error('Phi RPC model selection could not be confirmed')
          const notification: RpcModelSelectionNotification = {
            ...request,
            type: 'phi_rpc_model_selection',
            protocolVersion: 1,
            contextWindow: actual.contextWindow,
            maxTokens: actual.maxTokens
          }
          ctx.ui.notify(JSON.stringify(notification), 'info')
        } catch {
          // Provider failures must not echo gateway routing, credentials or supplied payloads.
          throw new Error('Phi RPC model selection could not be confirmed')
        } finally {
          selecting = false
        }
      }
    })
  }
}
