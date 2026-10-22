import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AuthStorage, FetchImpl } from '@oh-my-pi/pi-ai'
import { createAuthGatewayRouter } from '@oh-my-pi/pi-ai/auth-gateway/server'
import { transportFetch } from '@oh-my-pi/pi-ai/utils/transport-fetch'
import { logger } from '@oh-my-pi/pi-utils'
import {
  parseModelGatewayLease,
  type CreateModelGatewayLeaseParams,
  type ModelGatewayLease,
  type ModelGatewayModelRef,
  type RevokeModelGatewayLeaseParams,
  type SafeModelDescriptor
} from '../model-gateway-types'
import type { RuntimeContext, RuntimeModel } from './common'
import { getContext, modelBySelector } from './runtime-context'
import { isModelEnabled, readModelAvailability } from '../../model-availability'
import { GatewayInputError, readGatewayJson, validateGatewayPayload } from './model-gateway-request'
import {
  boundedGatewayStream,
  GATEWAY_STREAM_LIMITS,
  type GatewayStreamLimits
} from './model-gateway-stream'
import {
  createGatewayHttpListener,
  type GatewayHttpListener,
  type GatewayRequestHead
} from './model-gateway-http'
import { createScopedCursorH2Gateway, type ScopedCursorH2Gateway } from './scoped-cursor-h2-gateway'

// Worker startup policy, never toggled around concurrent/local requests. Phi's
// own IPC diagnostics remain intact; SDK transports may contain raw credentials.
delete process.env.PI_REQ_DEBUG
logger.setTransports({ file: false, console: false })

interface RequestScope {
  readonly model: RuntimeModel
  readonly controller: AbortController
  readonly fetch: FetchImpl
}
interface LeaseState {
  result: ModelGatewayLease
  readonly context: RuntimeContext
  readonly models: Map<string, RuntimeModel>
  readonly requests: Set<AbortController>
  readonly scope: AsyncLocalStorage<RequestScope>
  router?: ReturnType<typeof createAuthGatewayRouter>
  server?: GatewayHttpListener
  cursorGateway?: ScopedCursorH2Gateway
  active: boolean
  closing?: Promise<void>
}
interface GatewayDependencies {
  readonly streamLimits?: GatewayStreamLimits
  context(): Promise<RuntimeContext>
  model(context: RuntimeContext, ref: ModelGatewayModelRef): Promise<RuntimeModel | undefined>
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function identity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
}
function validateCreate(value: unknown): CreateModelGatewayLeaseParams {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !['sessionId', 'generation', 'models'].includes(key)) ||
    !identity(value.sessionId) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1 ||
    !Array.isArray(value.models) ||
    value.models.length < 1 ||
    value.models.length > 256
  )
    throw new Error('Invalid model gateway lease request')
  const seen = new Set<string>()
  const models = value.models.map((ref): ModelGatewayModelRef => {
    if (
      !record(ref) ||
      Object.keys(ref).some((key) => !['provider', 'id'].includes(key)) ||
      !identity(ref.provider) ||
      !identity(ref.id)
    )
      throw new Error('Invalid model gateway model reference')
    const key = `${ref.provider}/${ref.id}`
    if (seen.has(key)) throw new Error('Duplicate model gateway model reference')
    seen.add(key)
    return Object.freeze({ provider: ref.provider, id: ref.id })
  })
  return Object.freeze({
    sessionId: value.sessionId,
    generation: Number(value.generation),
    models: Object.freeze(models)
  })
}
function safeDescriptor(model: RuntimeModel): SafeModelDescriptor {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    reasoning: Boolean(model.reasoning),
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.cost
      ? {
          cost: {
            input: model.cost.input,
            output: model.cost.output,
            cacheRead: model.cost.cacheRead,
            cacheWrite: model.cost.cacheWrite
          }
        }
      : {})
  }
}
/** Cursor's selected logical row may route approved thinking levels to sibling wire IDs. */
export function cursorWireModelIds(model: RuntimeModel): readonly string[] {
  const ids = new Set<string>([model.id])
  if (model.requestModelId) ids.add(model.requestModelId)
  if (model.thinking?.mode === 'effort') {
    for (const route of Object.values(model.thinking.effortRouting ?? {})) {
      if (typeof route === 'string' && route) ids.add(route)
    }
  }
  return [...ids]
}
function failure(status: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: status === 401 ? 'authentication_error' : 'model_gateway_error',
        message:
          status === 413
            ? 'Model request exceeds its input limit'
            : status === 401
              ? 'Model gateway authentication failed'
              : status === 400
                ? 'Invalid model request'
                : 'Model request unavailable'
      }
    }),
    {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }
    }
  )
}

/** Preserve the SDK-selected vendor/CA/proxy transport and its private stamp. */
function redirectSafeFetch(
  model: RuntimeModel,
  controller: AbortController,
  active: () => boolean
): FetchImpl {
  const selected = transportFetch(model, undefined)
  return new Proxy(selected, {
    apply(target, receiver, args: Parameters<FetchImpl>) {
      return (async (): Promise<Response> => {
        let input = args[0]
        let init = { ...args[1], redirect: 'manual' as const }
        let url = new URL(input instanceof Request ? input.url : String(input))
        if (!['http:', 'https:'].includes(url.protocol))
          throw new Error('Unsupported model transport')
        for (let count = 0; count <= 5; count++) {
          if (!active() || controller.signal.aborted) throw new Error('Model request stopped')
          const response = (await Reflect.apply(target, receiver, [input, init])) as Response
          if (![301, 302, 303, 307, 308].includes(response.status)) return response
          const location = response.headers.get('location')
          await response.body?.cancel().catch(() => undefined)
          if (!location || location.length > 4096 || count === 5)
            throw new Error('Model redirect refused')
          const next = new URL(location, url)
          if (next.origin !== url.origin || !['http:', 'https:'].includes(next.protocol))
            throw new Error('Model redirect refused')
          const method = init.method ?? (input instanceof Request ? input.method : 'GET')
          if (
            response.status === 303 ||
            ([301, 302].includes(response.status) && method === 'POST')
          ) {
            const headers = new Headers(
              init.headers ?? (input instanceof Request ? input.headers : undefined)
            )
            headers.delete('content-type')
            headers.delete('content-length')
            init = { ...init, method: method === 'HEAD' ? 'HEAD' : 'GET', body: undefined, headers }
          } else if (input instanceof Request && init.body === undefined && input.body !== null) {
            throw new Error('Model redirect body cannot be replayed')
          }
          url = next
          input = next.href
        }
        throw new Error('Model redirect refused')
      })()
    }
  })
}

/** Only the registry resolver override is new; all credential refresh/rotation stays upstream. */
function storageFacade(state: LeaseState): AuthStorage {
  return new Proxy(state.context.authStorage, {
    get(storage, property) {
      if (property === 'keys') {
        // replaceStore rebuilds this namespace. Never capture one at lease creation.
        const keys = storage.keys
        return new Proxy(keys, {
          get(target, key) {
            if (key === 'getWithCredential')
              return async (
                _provider: string,
                _sessionId?: string,
                options?: Parameters<typeof target.getWithCredential>[2]
              ) => {
                const scope = state.scope.getStore()
                if (!state.active || !scope || scope.controller.signal.aborted) return undefined
                return state.context.modelRegistry.getApiKeyWithCredentialForProvider(
                  scope.model.provider,
                  state.result.leaseId,
                  {
                    ...options,
                    baseUrl: scope.model.baseUrl,
                    modelId: scope.model.id,
                    signal: scope.controller.signal
                  }
                )
              }
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }
      const value = Reflect.get(storage, property, storage)
      return typeof value === 'function' ? value.bind(storage) : value
    }
  })
}

/** One listener/router/provider-state store for each session generation. */
export class ModelGatewayManager {
  private closed = false
  private readonly leases = new Map<string, LeaseState>()
  private readonly claims = new Map<string, { generation: number; leaseId: string }>()
  private readonly streamLimits: GatewayStreamLimits
  constructor(
    private readonly dependencies: GatewayDependencies = {
      context: getContext,
      model: modelBySelector
    }
  ) {
    const limits = dependencies.streamLimits ?? GATEWAY_STREAM_LIMITS
    if (
      Object.keys(GATEWAY_STREAM_LIMITS).some((key) => {
        const value = Reflect.get(limits, key)
        return (
          !Number.isSafeInteger(value) ||
          value < 1 ||
          value > Reflect.get(GATEWAY_STREAM_LIMITS, key)
        )
      })
    )
      throw new Error('Invalid model gateway stream limits')
    // Trusted tests can lower budgets; neither callers nor later mutations can
    // increase the production bounds for an already created manager.
    this.streamLimits = Object.freeze({ ...limits })
  }

  diagnostics(): Readonly<{ leases: number; activeRequests: number }> {
    return Object.freeze({
      leases: [...this.leases.values()].filter((lease) => lease.active).length,
      activeRequests: [...this.leases.values()].reduce(
        (count, lease) => count + lease.requests.size,
        0
      )
    })
  }

  async create(value: unknown): Promise<ModelGatewayLease> {
    const params = validateCreate(value)
    if (this.closed) throw new Error('Model gateway manager is closed')
    const previous = this.claims.get(params.sessionId)
    if (previous && previous.generation >= params.generation)
      throw new Error('Model gateway generation is not fresh')
    const claim = { generation: params.generation, leaseId: randomUUID() }
    this.claims.set(params.sessionId, claim)
    if (previous) await this.revoke({ leaseId: previous.leaseId })
    let state: LeaseState | undefined
    try {
      const context = await this.dependencies.context()
      if (this.closed || this.claims.get(params.sessionId) !== claim)
        throw new Error('Model gateway generation was superseded')
      const available = new Set(
        context.modelRegistry
          .getAvailable()
          .map((model) => JSON.stringify([model.provider, model.id]))
      )
      const models = new Map<string, RuntimeModel>()
      for (const ref of params.models) {
        if (!available.has(JSON.stringify([ref.provider, ref.id])))
          throw new Error('Requested model is unavailable')
        const selected = await this.dependencies.model(context, ref)
        if (!selected || selected.provider !== ref.provider || selected.id !== ref.id)
          throw new Error('Requested model is unavailable')
        // In particular, Codex env WS precedence must not mutate the global model.
        models.set(`${ref.provider}/${ref.id}`, { ...selected, preferWebsockets: false })
      }
      if (this.claims.get(params.sessionId) !== claim)
        throw new Error('Model gateway generation was superseded')
      const scope = new AsyncLocalStorage<RequestScope>()
      const cursorModels = [...models.values()].filter((model) => model.provider === 'cursor')
      const cursorByWireId = new Map<string, RuntimeModel>()
      for (const model of cursorModels) {
        for (const wireId of cursorWireModelIds(model)) {
          const previous = cursorByWireId.get(wireId)
          if (previous && previous.id !== model.id)
            throw new Error('Ambiguous Cursor model route')
          cursorByWireId.set(wireId, model)
        }
      }
      const cursorBearerToken = cursorModels.length ? randomBytes(32).toString('base64url') : undefined
      const provisional = {
        leaseId: claim.leaseId,
        sessionId: params.sessionId,
        generation: params.generation,
        localPort: 1,
        bearerToken: randomBytes(32).toString('base64url'),
        ...(cursorBearerToken
          ? { cursor: { localPort: 1, bearerToken: cursorBearerToken } }
          : {}),
        models: [...models.values()].map(safeDescriptor)
      }
      const result = parseModelGatewayLease(provisional, params)
      state = {
        result,
        context,
        models,
        requests: new Set(),
        scope,
        active: true
      }
      const owner = state
      owner.router = createAuthGatewayRouter({
        storage: storageFacade(owner),
        resolveModel: (id) => (owner.active ? owner.models.get(id) : undefined),
        get fetch() {
          return owner.scope.getStore()?.fetch
        }
      })
      owner.server = await createGatewayHttpListener(
        (head) => this.admit(owner, head),
        (request) => this.handle(owner, request)
      )
      if (cursorBearerToken) {
        owner.cursorGateway = await createScopedCursorH2Gateway({
          token: cursorBearerToken,
          allowedModelIds: [...cursorByWireId.keys()],
          resolveBearer: async (wireModelId) => {
            const model = cursorByWireId.get(wireModelId)
            if (
              !model ||
              !owner.active ||
              !isModelEnabled(readModelAvailability(owner.context.agentDir), model.provider, model.id)
            ) throw new Error('Cursor model lease is inactive')
            const credential = await owner.context.modelRegistry.getApiKeyWithCredentialForProvider(
              model.provider,
              owner.result.leaseId,
              { baseUrl: model.baseUrl, modelId: model.id }
            )
            if (!owner.active || !credential?.apiKey)
              throw new Error('Cursor credential unavailable')
            return credential.apiKey
          }
        })
      }
      if (this.closed || this.claims.get(params.sessionId) !== claim)
        throw new Error('Model gateway generation was superseded')
      owner.result = parseModelGatewayLease({
        ...result,
        localPort: owner.server.port,
        ...(owner.cursorGateway
          ? { cursor: { localPort: owner.cursorGateway.port, bearerToken: cursorBearerToken } }
          : {})
      }, params)
      this.leases.set(owner.result.leaseId, owner)
      return owner.result
    } catch {
      if (state) await this.shutdown(state).catch(() => undefined)
      throw new Error('Model gateway lease could not be created')
    }
  }

  async revoke(value: unknown): Promise<void> {
    if (
      !record(value) ||
      Object.keys(value).some((key) => key !== 'leaseId') ||
      !identity(value.leaseId)
    )
      throw new Error('Invalid model gateway revocation')
    const state = this.leases.get(value.leaseId)
    if (!state) return
    state.active = false
    // Publish before shutdown can synchronously re-enter via SDK cleanup.
    state.closing ??= Promise.resolve()
      .then(() => this.shutdown(state))
      .finally(() => {
        if (this.leases.get(state.result.leaseId) === state)
          this.leases.delete(state.result.leaseId)
      })
    return state.closing
  }

  private async shutdown(state: LeaseState): Promise<void> {
    state.active = false
    for (const controller of state.requests) controller.abort(new Error('Model gateway revoked'))
    state.requests.clear()
    let failed = false
    try {
      state.router?.close()
    } catch {
      failed = true
    }
    try {
      await state.server?.close()
    } catch {
      failed = true
    }
    try {
      await state.cursorGateway?.close()
    } catch {
      failed = true
    }
    if (failed) throw new Error('Model gateway cleanup failed')
  }

  async closeAll(): Promise<void> {
    this.closed = true
    this.claims.clear()
    await Promise.all([...this.leases.keys()].map((leaseId) => this.revoke({ leaseId })))
  }

  private admit(state: LeaseState, request: GatewayRequestHead): Response | undefined {
    // No body/registry/credential access before route, active lease and own bearer.
    const url = new URL(request.url)
    if (!state.active) return failure(401)
    if (request.method !== 'POST' || url.pathname !== '/v1/pi/stream' || url.search)
      return failure(404)
    const expected = Buffer.from(`Bearer ${state.result.bearerToken}`)
    const actual = Buffer.from(request.headers.get('authorization') ?? '')
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual))
      return failure(401)
    if (state.requests.size >= 4) return failure(429)
    if (
      request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !==
      'application/json'
    )
      return failure(400)
    return undefined
  }

  private async handle(state: LeaseState, request: Request): Promise<Response> {
    const controller = new AbortController()
    state.requests.add(controller)
    const abort = (): void => controller.abort(new Error('Model gateway client stopped'))
    request.signal.addEventListener('abort', abort, { once: true })
    let streamOwnsRequest = false
    const finish = (): void => {
      state.requests.delete(controller)
      request.signal.removeEventListener('abort', abort)
    }
    try {
      if (request.signal.aborted) abort()
      const payload = validateGatewayPayload(
        await readGatewayJson(request, controller.signal),
        state.result.leaseId
      )
      const model = state.models.get(payload.modelId)
      if (!model || !state.active || controller.signal.aborted) return failure(400)
      // A lease retains its credentials/catalog, but each new request honors current switches.
      // Already admitted streams keep their captured model until their own completion/stop.
      if (!isModelEnabled(readModelAvailability(state.context.agentDir), model.provider, model.id))
        return failure(403)
      const scope: RequestScope = {
        model,
        controller,
        fetch: redirectSafeFetch(model, controller, () => state.active)
      }
      const response = await state.scope.run(scope, () =>
        state.router!.route(
          new Request('http://phi.gateway/v1/pi/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
          }),
          'phi-model-gateway'
        )
      )
      if (!state.active || controller.signal.aborted || !response.ok || !response.body) {
        controller.abort()
        await response.body?.cancel().catch(() => undefined)
        return failure(response.status >= 400 && response.status <= 599 ? response.status : 502)
      }
      const body = boundedGatewayStream(response.body, controller, model, finish, this.streamLimits)
      streamOwnsRequest = true
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        }
      })
    } catch (error) {
      controller.abort()
      return failure(error instanceof GatewayInputError ? error.status : 502)
    } finally {
      if (!streamOwnsRequest) finish()
    }
  }
}

const manager = new ModelGatewayManager()
export const createModelGatewayLease = (
  params: CreateModelGatewayLeaseParams
): Promise<ModelGatewayLease> => manager.create(params)
export const revokeModelGatewayLease = (params: RevokeModelGatewayLeaseParams): Promise<void> =>
  manager.revoke(params)
export const closeAllModelGatewayLeases = (): Promise<void> => manager.closeAll()
