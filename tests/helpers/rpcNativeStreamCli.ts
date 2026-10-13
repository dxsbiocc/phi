import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import { createRpcNativeStreamExtension } from '../../src/main/agent/engine/phi-extension/extensions/rpc-native-stream'
import type { TrustedNativeStreamScope } from '../../src/main/agent/engine/phi-extension/lib/rpc-native-stream-adapter'

const path = process.env.PHI_NATIVE_FIXTURE_SCOPE
if (!path) throw new Error('Private native CLI scope required')
const supplied = JSON.parse(readFileSync(path, 'utf8')) as Omit<
  TrustedNativeStreamScope,
  'isActive'
>
const extension: ExtensionFactory = async (pi) => {
  let instance = randomUUID()
  let controller = createRpcNativeStreamExtension({ ...supplied, isActive: () => true })
  await controller.extension(pi)
  pi.on('session_start', (_event, ctx) => {
    controller.assertInstalled(ctx)
    ctx.ui.notify(
      JSON.stringify({
        type: 'native_fixture_ready',
        sessionId: ctx.sessionManager.getSessionId()
      }),
      'info'
    )
  })
  pi.registerCommand('phi-native-status', {
    handler: async (args, ctx) => {
      controller.assertInstalled(ctx)
      ctx.ui.notify(
        JSON.stringify({
          type: 'native_fixture_status',
          instance,
          nonce: args,
          sessionId: ctx.sessionManager.getSessionId()
        }),
        'info'
      )
    }
  })
  pi.registerCommand('phi-native-reinstall', {
    handler: async (args, ctx) => {
      const agent = pi.pi.AgentRegistry.global().get(ctx.agent.id)!.session!.agent
      const before = agent.streamFn
      await controller.extension(pi)
      controller.assertInstalled(ctx)
      ctx.ui.notify(
        JSON.stringify({
          type: 'native_fixture_reinstall',
          nonce: args,
          same: before === agent.streamFn
        }),
        'info'
      )
    }
  })
  pi.registerCommand('phi-native-reload', {
    handler: async (_args, ctx) => {
      await ctx.reload()
    }
  })
  pi.registerCommand('phi-native-rebind', {
    handler: async (_args, ctx) => {
      controller.dispose()
      controller = createRpcNativeStreamExtension({ ...supplied, isActive: () => true })
      instance = randomUUID()
      await controller.extension(pi)
      await ctx.reload()
      controller.assertInstalled(ctx)
    }
  })
  pi.registerCommand('phi-native-ownership', {
    handler: async (args, ctx) => {
      const agent = pi.pi.AgentRegistry.global().get(ctx.agent.id)!.session!.agent
      const before = agent.streamFn
      const foreign: typeof before = (...values) => before(...values)
      agent.streamFn = foreign
      let rejected = false
      try {
        controller.assertInstalled(ctx)
      } catch {
        rejected = true
      }
      controller.dispose()
      ctx.ui.notify(
        JSON.stringify({
          type: 'native_fixture_ownership',
          nonce: args,
          rejected,
          foreignPreserved: agent.streamFn === foreign
        }),
        'info'
      )
    }
  })
}
export default extension
