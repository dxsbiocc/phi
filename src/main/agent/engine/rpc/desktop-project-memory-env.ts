import { resolveWorkerProxyEnv } from '../worker-proxy-env'

/**
 * This is the same trusted, tool-less desktop SDK flow as OmpBridge, split only
 * for physical cancellation. Keep native environment auth, !cmd brokers and CA/proxy
 * behavior intact. Never use this environment for server or host-tool processes,
 * and never serialize it into a request, cache, or diagnostic.
 */
export function projectMemoryWorkerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, ...resolveWorkerProxyEnv(env) }
}
