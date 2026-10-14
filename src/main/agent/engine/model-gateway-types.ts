/** Explicit model metadata safe to publish to a remote model configuration. */
export interface ModelGatewayModelRef {
  readonly provider: string
  readonly id: string
}

export interface SafeModelDescriptor extends ModelGatewayModelRef {
  readonly name: string
  readonly reasoning: boolean
  readonly input: readonly ('text' | 'image')[]
  readonly contextWindow: number | null
  readonly maxTokens: number | null
  readonly cost?: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
}

export interface CreateModelGatewayLeaseParams {
  readonly sessionId: string
  readonly generation: number
  readonly models: readonly ModelGatewayModelRef[]
}

export interface RevokeModelGatewayLeaseParams {
  readonly leaseId: string
}

/** Internal worker-to-Node response. Never expose this bearer or port to the renderer. */
export interface ModelGatewayLease {
  readonly leaseId: string
  readonly sessionId: string
  readonly generation: number
  readonly localPort: number
  readonly bearerToken: string
  readonly models: readonly SafeModelDescriptor[]
}

function boundedString(value: unknown, limit: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > limit ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error(`Invalid model gateway ${label}`)
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid model gateway response')
  return value as Record<string, unknown>
}

function finiteNumber(value: unknown, label: string, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && (!Number.isSafeInteger(value) || value === 0))
  )
    throw new Error(`Invalid model gateway ${label}`)
  return value
}

/** Reconstruct the whitelist; a worker result never forwards unknown SDK fields. */
export function parseModelGatewayLease(
  value: unknown,
  expected: CreateModelGatewayLeaseParams
): ModelGatewayLease {
  const raw = record(value)
  if (
    raw.sessionId !== expected.sessionId ||
    raw.generation !== expected.generation ||
    !Number.isSafeInteger(raw.generation) ||
    expected.generation < 1
  )
    throw new Error('Model gateway generation does not match its owner')
  const localPort = finiteNumber(raw.localPort, 'port', true)
  if (localPort > 65535) throw new Error('Invalid model gateway port')
  const bearerToken = boundedString(raw.bearerToken, 64, 'bearer')
  if (!/^(?:[a-zA-Z0-9_-]{43}|[a-f0-9]{64})$/.test(bearerToken))
    throw new Error('Invalid model gateway bearer')
  if (
    !Array.isArray(raw.models) ||
    !raw.models.length ||
    raw.models.length > 256 ||
    raw.models.length !== expected.models.length
  )
    throw new Error('Invalid model gateway model set')
  const remaining = new Set(
    expected.models.map(({ provider, id }) => JSON.stringify([provider, id]))
  )
  if (remaining.size !== expected.models.length) throw new Error('Duplicate model gateway model')
  const models = raw.models.map((item): SafeModelDescriptor => {
    const model = record(item)
    const provider = boundedString(model.provider, 256, 'provider')
    const id = boundedString(model.id, 256, 'model id')
    if (!remaining.delete(JSON.stringify([provider, id])))
      throw new Error('Unexpected model gateway model')
    if (
      typeof model.reasoning !== 'boolean' ||
      !Array.isArray(model.input) ||
      !model.input.length ||
      model.input.length > 2 ||
      new Set(model.input).size !== model.input.length ||
      model.input.some((input) => input !== 'text' && input !== 'image')
    )
      throw new Error('Invalid model gateway model capabilities')
    let cost: SafeModelDescriptor['cost']
    if (model.cost !== undefined) {
      const source = record(model.cost)
      cost = Object.freeze({
        input: finiteNumber(source.input, 'input cost'),
        output: finiteNumber(source.output, 'output cost'),
        cacheRead: finiteNumber(source.cacheRead, 'cache read cost'),
        cacheWrite: finiteNumber(source.cacheWrite, 'cache write cost')
      })
    }
    return Object.freeze({
      provider,
      id,
      name: boundedString(model.name, 512, 'model name'),
      reasoning: model.reasoning,
      input: Object.freeze(model.input.slice()) as SafeModelDescriptor['input'],
      contextWindow:
        model.contextWindow === null
          ? null
          : finiteNumber(model.contextWindow, 'context window', true),
      maxTokens:
        model.maxTokens === null ? null : finiteNumber(model.maxTokens, 'max tokens', true),
      ...(cost ? { cost } : {})
    })
  })
  return Object.freeze({
    leaseId: boundedString(raw.leaseId, 256, 'lease id'),
    sessionId: expected.sessionId,
    generation: expected.generation,
    localPort,
    bearerToken,
    models: Object.freeze(models)
  })
}
