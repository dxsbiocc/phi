import type { Api, Model } from '@oh-my-pi/pi-ai'
import { projectNativeWireBody } from '../phi-extension/lib/rpc-native-wire'

/**
 * OMP's native client serializes the live context, so wrapped tools would carry their whole
 * session and runner state to the gateway. Keep the request to the public wire contract.
 */
export function withNativeWireProjection(
  requestFetch: typeof globalThis.fetch,
  model: Model<Api>
): typeof globalThis.fetch {
  if (model.transport !== 'pi-native') return requestFetch
  return (input, init) =>
    requestFetch(input, {
      ...init,
      body: projectNativeWireBody(init?.body, `${model.provider}/${model.id}`)
    })
}
