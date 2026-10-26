import type { RuntimeSessionManager } from './runtime-adapter'

export function pickSessionManager(
  manager: RuntimeSessionManager | undefined,
  fallback: RuntimeSessionManager
): RuntimeSessionManager {
  return manager ?? fallback
}
