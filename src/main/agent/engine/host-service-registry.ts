import type { PhiHostRequestContext, PhiHostRequestHandler } from './types'

/** Trusted Node service registration shared by the worker and curated RPC tool adapters. */
export class HostServiceRegistry {
  private readonly handlers = new Map<string, PhiHostRequestHandler>()

  register(method: string, handler: PhiHostRequestHandler): () => void {
    this.handlers.set(method, handler)
    return () => {
      if (this.handlers.get(method) === handler) this.handlers.delete(method)
    }
  }

  async invoke(method: string, params: unknown, context: PhiHostRequestContext): Promise<unknown> {
    const handler = this.handlers.get(method)
    if (!handler) throw new Error(`Unknown host request method: ${method}`)
    return handler(params, context)
  }
}
