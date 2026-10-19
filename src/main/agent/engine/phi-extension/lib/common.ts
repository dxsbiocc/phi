/**
 * Deliberately local, not imported from src/shared/guards.
 *
 * Everything under phi-extension/ is bundled and uploaded to the remote host, and
 * validatePhiExtensionBundle rejects any dependency that lives outside the bundle:
 * importing the shared guard fails with "Missing extension dependency in
 * lib/common.ts: ../../../../../shared/guards". Keeping this copy is the bundle
 * contract, not leftover duplication.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
