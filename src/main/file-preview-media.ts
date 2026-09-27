const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function mediaPreviewType(
  bytes: Buffer
): { kind: 'image'; mimeType: 'image/png' } | { kind: 'pdf'; mimeType: 'application/pdf' } | null {
  if (
    bytes.length >= PNG_SIGNATURE.length &&
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return { kind: 'image', mimeType: 'image/png' }
  }
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { kind: 'pdf', mimeType: 'application/pdf' }
  }
  return null
}

export function hoverMediaPreviewType(
  bytes: Buffer
):
  | { kind: 'image'; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }
  | { kind: 'pdf'; mimeType: 'application/pdf' }
  | null {
  const fullPreviewType = mediaPreviewType(bytes)
  if (fullPreviewType) return fullPreviewType
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'image', mimeType: 'image/jpeg' }
  }
  const signature = bytes.subarray(0, 6).toString('ascii')
  if (signature === 'GIF87a' || signature === 'GIF89a') {
    return { kind: 'image', mimeType: 'image/gif' }
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { kind: 'image', mimeType: 'image/webp' }
  }
  return null
}
