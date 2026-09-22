import {
  databaseWebPreviewRequestFromString,
  type DatabaseWebImagePreview
} from '../shared/databaseWebPreview'

const DATABASE_WEB_PREVIEW_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024
const DATABASE_WEB_PREVIEW_TIMEOUT_MS = 15_000

async function fetchDatabaseWebPreviewImage(imageUrl: string): Promise<{
  bytes: Buffer
  mimeType: string
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DATABASE_WEB_PREVIEW_TIMEOUT_MS)

  try {
    const response = await fetch(imageUrl, {
      signal: controller.signal,
      headers: { accept: 'image/png' }
    })
    if (!response.ok) {
      throw new Error(`Database preview image request failed: HTTP ${response.status}`)
    }

    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (mimeType !== 'image/png') {
      throw new Error(`Database preview returned unsupported image type: ${mimeType ?? 'unknown'}`)
    }

    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > DATABASE_WEB_PREVIEW_IMAGE_LIMIT_BYTES) {
      throw new Error('Database preview image is too large to show')
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > DATABASE_WEB_PREVIEW_IMAGE_LIMIT_BYTES) {
      throw new Error('Database preview image is too large to show')
    }
    return { bytes, mimeType }
  } finally {
    clearTimeout(timeout)
  }
}

export async function previewDatabaseWebImage(sourceUrl: string): Promise<DatabaseWebImagePreview> {
  const request = databaseWebPreviewRequestFromString(sourceUrl)
  if (!request) throw new Error('不是可预览的数据库网页链接')

  const { bytes, mimeType } = await fetchDatabaseWebPreviewImage(request.imageUrl)
  return {
    ...request,
    dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
    mimeType: 'image/png',
    bytes: bytes.length
  }
}
