import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  type PromptImageInput,
  type PromptImageMimeType,
  type StoredPromptImage
} from '../../../shared/promptImageTypes'
import { findPhiSessionById, getSessionDir } from './session-store'

const EXTENSIONS: Record<PromptImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

function isMimeType(value: unknown): value is PromptImageMimeType {
  return typeof value === 'string' && Object.hasOwn(EXTENSIONS, value)
}

function matchesMimeType(bytes: Buffer, mimeType: PromptImageMimeType): boolean {
  if (mimeType === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8
  if (mimeType === 'image/gif')
    return (
      bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('ascii') === 'GIF89a'
    )
  return (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
}

function decodeImage(value: unknown): { mimeType: PromptImageMimeType; bytes: Buffer } {
  if (!value || typeof value !== 'object') throw new Error('图片数据无效')
  const image = value as Record<string, unknown>
  if (!isMimeType(image.mimeType) || typeof image.data !== 'string') {
    throw new Error('不支持的图片格式')
  }
  if (image.data.length > Math.ceil(MAX_PROMPT_IMAGE_BYTES / 3) * 4 + 4) {
    throw new Error('图片超过 8 MB 限制')
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length % 4 !== 0) {
    throw new Error('图片数据无效')
  }
  const bytes = Buffer.from(image.data, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_PROMPT_IMAGE_BYTES) {
    throw new Error('图片为空或超过 8 MB 限制')
  }
  if (!matchesMimeType(bytes, image.mimeType)) throw new Error('图片内容与格式不符')
  return { mimeType: image.mimeType, bytes }
}

export function validatePromptImages(value: unknown): PromptImageInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_PROMPT_IMAGES) {
    throw new Error(`一次最多发送 ${MAX_PROMPT_IMAGES} 张图片`)
  }
  return value.map((image) => {
    const decoded = decodeImage(image)
    return { mimeType: decoded.mimeType, data: decoded.bytes.toString('base64') }
  })
}

export function persistPromptImages(
  sessionId: string,
  images: readonly PromptImageInput[]
): StoredPromptImage[] {
  if (!findPhiSessionById(sessionId)) throw new Error('会话不存在')
  const dir = join(getSessionDir(sessionId), 'artifacts', 'prompt-images')
  mkdirSync(dir, { recursive: true })
  return images.map((image) => {
    const bytes = Buffer.from(image.data, 'base64')
    const id = createHash('sha256').update(bytes).digest('hex')
    const path = join(dir, `${id}.${EXTENSIONS[image.mimeType]}`)
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' })
    return { sessionId, id, mimeType: image.mimeType }
  })
}

export function readPromptImage(value: unknown): PromptImageInput {
  if (!value || typeof value !== 'object') throw new Error('图片引用无效')
  const ref = value as Record<string, unknown>
  if (
    typeof ref.sessionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref.sessionId) ||
    !findPhiSessionById(ref.sessionId) ||
    typeof ref.id !== 'string' ||
    !/^[0-9a-f]{64}$/.test(ref.id) ||
    !isMimeType(ref.mimeType)
  ) {
    throw new Error('图片引用无效')
  }
  const path = join(
    getSessionDir(ref.sessionId),
    'artifacts',
    'prompt-images',
    `${ref.id}.${EXTENSIONS[ref.mimeType]}`
  )
  const bytes = readFileSync(path)
  if (
    bytes.length > MAX_PROMPT_IMAGE_BYTES ||
    createHash('sha256').update(bytes).digest('hex') !== ref.id ||
    !matchesMimeType(bytes, ref.mimeType)
  ) {
    throw new Error('图片文件校验失败')
  }
  return { mimeType: ref.mimeType, data: bytes.toString('base64') }
}
