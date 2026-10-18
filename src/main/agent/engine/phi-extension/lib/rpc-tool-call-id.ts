/**
 * Provider tool-call ids are opaque, model-provider-chosen strings. Some providers (for example
 * Cursor) embed newlines or exceed the strict identifier rule used for Phi-minted ids. They only
 * ever travel as JSON string values and inside canonical JSON digests, so control characters are
 * safe here; only emptiness, size and well-formed unicode are enforced. Ids that already satisfy
 * the strict rule hash exactly as before.
 */
export const MAX_RPC_TOOL_CALL_ID_LENGTH = 1024
export function toolCallIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_RPC_TOOL_CALL_ID_LENGTH &&
    value.isWellFormed()
  )
}
