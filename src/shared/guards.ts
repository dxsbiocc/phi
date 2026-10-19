/**
 * Shared runtime type guards.
 *
 * `isRecord` existed as 80 near-identical local copies under `src/` before they
 * were consolidated here. Keep this module dependency-free so the main process,
 * the preload bridge, and the renderer can all import it.
 */

/** A JSON-ish object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
