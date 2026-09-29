import type { StoredPromptImage } from '../../../../../shared/promptImageTypes'

export function storedPromptImages(value: unknown): StoredPromptImage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((image): StoredPromptImage[] => {
    if (!image || typeof image !== 'object') return []
    const ref = image as Record<string, unknown>
    if (
      typeof ref.sessionId !== 'string' ||
      typeof ref.id !== 'string' ||
      !/^[0-9a-f]{64}$/.test(ref.id) ||
      !(
        ref.mimeType === 'image/png' ||
        ref.mimeType === 'image/jpeg' ||
        ref.mimeType === 'image/gif' ||
        ref.mimeType === 'image/webp'
      )
    ) {
      return []
    }
    return [{ sessionId: ref.sessionId, id: ref.id, mimeType: ref.mimeType }]
  })
}
