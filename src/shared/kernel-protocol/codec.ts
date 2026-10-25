import { KERNEL_V1_METHODS, MAX_FRAME_BYTES, type KernelV1Method } from './constants'
import { ProtocolEncodeError, type ProtocolError } from './errors'
import { parsedFrameSchema, type ParsedFrame } from './frames'
import { containsReservedIdentityField, type JsonValue } from './json'
import { kernelMethodParamsSchemas } from './methods'

const textEncoder = new TextEncoder()
const knownMethods = new Set<string>(KERNEL_V1_METHODS)

function protocolError(code: ProtocolError['code'], message: string): ProtocolError {
  return { code, message }
}

function withoutLineDelimiter(line: string): string {
  if (!line.endsWith('\n')) return line
  const withoutLf = line.slice(0, -1)
  return withoutLf.endsWith('\r') ? withoutLf.slice(0, -1) : withoutLf
}

function validateKnownRequestParams(frame: ParsedFrame): ParsedFrame | ProtocolError {
  if (frame.kind !== 'request' || !knownMethods.has(frame.method)) return frame

  const method = frame.method as KernelV1Method
  const parsed = kernelMethodParamsSchemas[method].safeParse(frame.params)
  if (!parsed.success) {
    return protocolError('INVALID_PARAMS', `Request params are invalid for ${method}.`)
  }

  const params = parsed.data as JsonValue
  const fixedObjects =
    method === 'kernel.hello' &&
    typeof params === 'object' &&
    params !== null &&
    !Array.isArray(params)
      ? [params.client, params.protocol]
      : []
  if (
    containsReservedIdentityField(params) ||
    fixedObjects.some((value) => containsReservedIdentityField(value))
  ) {
    return protocolError('INVALID_PARAMS', `Request params are invalid for ${method}.`)
  }

  return { ...frame, params }
}

export function parseFrame(line: string): ParsedFrame | ProtocolError {
  if (typeof line !== 'string') return protocolError('INVALID_FRAME', 'Frame must be text.')

  const payload = withoutLineDelimiter(line)
  if (textEncoder.encode(payload).byteLength + 1 > MAX_FRAME_BYTES) {
    return protocolError('FRAME_TOO_LARGE', `Frame exceeds ${MAX_FRAME_BYTES} UTF-8 bytes.`)
  }

  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return protocolError('INVALID_FRAME', 'Frame is not valid JSON.')
  }

  const parsed = parsedFrameSchema.safeParse(value)
  if (!parsed.success) {
    return protocolError('INVALID_FRAME', 'Frame has an unsupported kind or invalid shape.')
  }
  if (parsed.data.kind === 'request' && containsReservedIdentityField(parsed.data as JsonValue)) {
    return protocolError('INVALID_FRAME', 'Identity and permission fields are not accepted.')
  }
  const withKnownParams = validateKnownRequestParams(parsed.data)
  if (!('kind' in withKnownParams)) return withKnownParams

  return withKnownParams
}

function assertArraySerializable(value: unknown[], ancestors: Set<object>): void {
  const ownKeys = Reflect.ownKeys(value)
  const hasInvalidKey = ownKeys.some(
    (key) =>
      key !== 'length' &&
      (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
  )
  if (hasInvalidKey) {
    throw new ProtocolEncodeError('INVALID_FRAME', 'Frame contains an invalid array property.')
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor) {
      throw new ProtocolEncodeError('INVALID_FRAME', 'Frame contains a sparse array.')
    }
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new ProtocolEncodeError('INVALID_FRAME', 'Frame contains a hidden or computed value.')
    }
    assertSerializable(descriptor.value, ancestors)
  }
}

function assertPlainObjectSerializable(value: object, ancestors: Set<object>): void {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolEncodeError('INVALID_FRAME', 'Frame contains a non-plain object.')
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      throw new ProtocolEncodeError('INVALID_FRAME', 'Frame contains a symbol key.')
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new ProtocolEncodeError('INVALID_FRAME', 'Frame contains a hidden or computed value.')
    }
    assertSerializable(descriptor.value, ancestors)
  }
}

function assertSerializable(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object') {
    throw new ProtocolEncodeError('INVALID_FRAME', 'Frame contains a non-serializable value.')
  }
  if (ancestors.has(value)) {
    throw new ProtocolEncodeError('INVALID_FRAME', 'Frame contains a cycle.')
  }

  ancestors.add(value)
  if (Array.isArray(value)) assertArraySerializable(value, ancestors)
  else assertPlainObjectSerializable(value, ancestors)
  ancestors.delete(value)
}

export function encodeFrame(frame: ParsedFrame): string {
  try {
    assertSerializable(frame)
  } catch (error) {
    if (error instanceof ProtocolEncodeError) throw error
    throw new ProtocolEncodeError('INVALID_FRAME', 'Frame could not be inspected safely.')
  }

  let payload: string
  try {
    payload = JSON.stringify(frame)
  } catch {
    throw new ProtocolEncodeError('INVALID_FRAME', 'Frame could not be serialized.')
  }

  const parsed = parseFrame(payload)
  if (!('kind' in parsed)) {
    const code = parsed.code === 'FRAME_TOO_LARGE' ? 'FRAME_TOO_LARGE' : 'INVALID_FRAME'
    throw new ProtocolEncodeError(code, parsed.message)
  }
  return `${payload}\n`
}
