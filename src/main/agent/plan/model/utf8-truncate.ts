const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value)
  const limit = Math.max(0, Math.min(bytes.byteLength, Math.floor(maxBytes)))
  if (limit === bytes.byteLength) return value
  for (let end = limit; end >= Math.max(0, limit - 3); end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end))
    } catch {
      // A UTF-8 code point uses at most four bytes.
    }
  }
  return ''
}
