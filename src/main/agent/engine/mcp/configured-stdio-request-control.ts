const DEFAULT_TIMEOUT_MS = 90_000
const MIN_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 900_000
const MAX_REQUEST_KEY_LENGTH = 128

export type ConfiguredStdioTimeoutRange = {
  defaultMs: number
  minMs: number
  maxMs: number
}

const productionTimeoutRange: ConfiguredStdioTimeoutRange = {
  defaultMs: DEFAULT_TIMEOUT_MS,
  minMs: MIN_TIMEOUT_MS,
  maxMs: MAX_TIMEOUT_MS
}

export function resolveConfiguredStdioTimeoutMs(
  value: unknown,
  range: ConfiguredStdioTimeoutRange = productionTimeoutRange
): number {
  if (value === undefined) return range.defaultMs
  if (!Number.isSafeInteger(value)) throw new Error('Invalid MCP discovery timeoutMs')
  return Math.min(range.maxMs, Math.max(range.minMs, Number(value)))
}

export function configuredStdioTimeoutMessage(timeoutMs: number): string {
  const waited =
    timeoutMs < 60_000
      ? `${Math.max(1, Math.round(timeoutMs / 1000))} seconds`
      : `${Number((timeoutMs / 60_000).toFixed(2))} minutes`
  return `Startup verification timed out after ${waited}. The first run usually downloads dependencies. Downloaded files are kept; you can retry.`
}

export function configuredStdioRequestKey(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_REQUEST_KEY_LENGTH ||
    !/^[A-Za-z0-9:_-]+$/u.test(value)
  ) {
    throw new Error('Invalid MCP discovery requestKey')
  }
  return value
}

export class ConfiguredStdioRequestRegistry {
  private readonly controllers = new Map<string, AbortController>()

  register(requestKey: string | undefined, controller: AbortController): void {
    if (!requestKey) return
    if (this.controllers.has(requestKey)) throw new Error('MCP discovery request is already active')
    this.controllers.set(requestKey, controller)
  }

  cancel(requestKey: string): boolean {
    const controller = this.controllers.get(requestKey)
    if (!controller) return false
    controller.abort(new Error('Cancelled'))
    return true
  }

  delete(requestKey: string | undefined, controller: AbortController): void {
    if (requestKey && this.controllers.get(requestKey) === controller) {
      this.controllers.delete(requestKey)
    }
  }

  has(requestKey: string): boolean {
    return this.controllers.has(requestKey)
  }
}
