export const MAX_PROMPT_IMAGES = 4
export const MAX_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024

export type PromptImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** Base64 bytes from a pasted image. Drafts stay in renderer memory until sent. */
export interface PromptImageInput {
  mimeType: PromptImageMimeType
  data: string
}

/** A content-addressed image saved under a Phi session's artifacts directory. */
export interface StoredPromptImage {
  sessionId: string
  id: string
  mimeType: PromptImageMimeType
}
