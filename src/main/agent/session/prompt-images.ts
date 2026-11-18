import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { dirname, join } from 'node:path'

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
const NO_FOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK

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
  return Array.from(value, (image) => {
    const decoded = decodeImage(image)
    return { mimeType: decoded.mimeType, data: decoded.bytes.toString('base64') }
  })
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isOwnerWritableOnly(info: Stats): boolean {
  return (
    process.platform === 'win32' ||
    ((info.mode & 0o022) === 0 && info.uid === (process.getuid?.() ?? info.uid))
  )
}

function assertArchiveDirectory(info: Stats): void {
  if (!info.isDirectory() || !isOwnerWritableOnly(info)) {
    throw new Error('图片文件目录校验失败')
  }
}

function ensureArchiveDirectory(directory: string): void {
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

function imageArchiveDirectories(sessionId: string, create: boolean): string[] {
  const session = getSessionDir(sessionId)
  const sessions = dirname(session)
  const artifacts = join(session, 'artifacts')
  const images = join(artifacts, 'prompt-images')
  const agent = realpathSync(dirname(sessions))
  for (const directory of [agent, sessions, session, artifacts, images]) {
    if (create && (directory === artifacts || directory === images)) {
      ensureArchiveDirectory(directory)
    }
    assertArchiveDirectory(lstatSync(directory))
  }
  return [images, artifacts, session, sessions, agent]
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertArchiveFile(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1 || !isOwnerWritableOnly(info)) {
    throw new Error('图片文件校验失败')
  }
}

function assertSameArchiveFile(expected: Stats, actual: Stats): void {
  assertArchiveFile(actual)
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.size !== actual.size ||
    expected.mtimeMs !== actual.mtimeMs ||
    expected.ctimeMs !== actual.ctimeMs
  ) {
    throw new Error('图片文件校验失败')
  }
}

function readArchiveImage(
  path: string,
  { id, mimeType }: StoredPromptImage,
  durableLength?: number
): Buffer | null {
  const before = lstatSync(path)
  assertArchiveFile(before)
  if (before.size <= 0 || before.size > MAX_PROMPT_IMAGE_BYTES) return null
  const syncing = durableLength !== undefined
  if (
    syncing &&
    (before.size !== durableLength || (process.platform !== 'win32' && (before.mode & 0o077) !== 0))
  ) {
    // Old builds used the process umask. Rewrite those files privately when re-archiving.
    return null
  }

  const fd = openSync(path, (syncing ? constants.O_RDWR : constants.O_RDONLY) | NO_FOLLOW)
  try {
    const opened = fstatSync(fd)
    assertSameArchiveFile(before, opened)
    const buffer = Buffer.alloc(opened.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (!read) break
      offset += read
    }
    const bytes = buffer.subarray(0, offset)
    if (offset !== opened.size || digest(bytes) !== id || !matchesMimeType(bytes, mimeType)) {
      return null
    }
    if (syncing) fsyncSync(fd)
    assertSameArchiveFile(opened, fstatSync(fd))
    assertSameArchiveFile(opened, lstatSync(path))
    return bytes
  } finally {
    closeSync(fd)
  }
}

function writeArchiveImage(path: string, bytes: Buffer): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function syncArchiveDirectories(directories: string[]): void {
  // Node can flush the file on Windows, where opening a directory for fsync is unsupported.
  if (process.platform === 'win32') return
  for (const directory of directories) {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW)
    try {
      assertArchiveDirectory(fstatSync(fd))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

export function persistPromptImages(
  sessionId: string,
  images: readonly PromptImageInput[]
): StoredPromptImage[] {
  if (!findPhiSessionById(sessionId)) throw new Error('会话不存在')
  if (images.length === 0) return []
  const directories = imageArchiveDirectories(sessionId, true)
  const refs = images.map((image) => {
    const { mimeType, bytes } = decodeImage(image)
    const ref = { sessionId, id: digest(bytes), mimeType }
    const path = join(directories[0], `${ref.id}.${EXTENSIONS[mimeType]}`)
    try {
      if (readArchiveImage(path, ref, bytes.length)) return ref
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    writeArchiveImage(path, bytes)
    return ref
  })
  // Sync every directory link so a new session or archive is durable before publishing its ref.
  syncArchiveDirectories(directories)
  return refs
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
  const [directory] = imageArchiveDirectories(ref.sessionId, false)
  const path = join(directory, `${ref.id}.${EXTENSIONS[ref.mimeType]}`)
  const bytes = readArchiveImage(path, {
    sessionId: ref.sessionId,
    id: ref.id,
    mimeType: ref.mimeType
  })
  if (!bytes) throw new Error('图片文件校验失败')
  return { mimeType: ref.mimeType, data: bytes.toString('base64') }
}
