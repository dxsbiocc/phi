import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import {
  MAX_PROMPT_IMAGE_BYTES,
  type PromptImageInput,
  type PromptImageMimeType
} from '../../shared/promptImageTypes'
import { isMissingFile, syncDirectory } from '../agent/engine/kernel-history/atomic-file'
import { validatePromptImages } from '../agent/session/prompt-images'

const DIGEST_FILE = /^([0-9a-f]{64})\.image$/
const TEMP_FILE = /^\.tmp\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const READ_FLAGS =
  constants.O_RDONLY |
  (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)

export interface AssistantInboxAttachment {
  readonly digest: string
  readonly mimeType: PromptImageMimeType
  readonly bytes: number
}

interface PreparedAttachment {
  ref: AssistantInboxAttachment
  data: Buffer
}

interface AssistantInboxAttachments {
  stage(prepared: readonly PreparedAttachment[]): Promise<void>
  load(refs: readonly AssistantInboxAttachment[]): Promise<PromptImageInput[]>
  sweep(retainedDigests: ReadonlySet<string>): Promise<void>
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function prepareAssistantInboxAttachments(images: unknown): PreparedAttachment[] {
  return validatePromptImages(images).map((image) => {
    const data = Buffer.from(image.data, 'base64')
    return { ref: { digest: sha256(data), mimeType: image.mimeType, bytes: data.length }, data }
  })
}

function isPrivate(stats: Stats): boolean {
  return process.platform === 'win32' || (stats.mode & 0o077) === 0
}

async function checkedDirectory(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || !isPrivate(info)) {
      throw new Error('Assistant inbox attachments directory must be private.')
    }
    return true
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

function isPrivateFile(info: Stats): boolean {
  return info.isFile() && info.nlink === 1 && isPrivate(info)
}

async function readAttachment(path: string, ref: AssistantInboxAttachment): Promise<Buffer> {
  const before = await lstat(path)
  if (!isPrivateFile(before) || before.size !== ref.bytes || before.size > MAX_PROMPT_IMAGE_BYTES) {
    throw new Error('Invalid assistant inbox attachment file.')
  }

  const handle = await open(path, READ_FLAGS)
  try {
    const opened = await handle.stat()
    if (
      !isPrivateFile(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error('Assistant inbox attachment changed while opening.')
    }
    // Read one extra byte to detect growth, without relying on readFile's allocation.
    const buffer = Buffer.alloc(opened.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const bytes = buffer.subarray(0, offset)
    const after = await handle.stat()
    if (
      offset !== ref.bytes ||
      after.size !== ref.bytes ||
      !isPrivateFile(after) ||
      sha256(bytes) !== ref.digest
    ) {
      throw new Error('Assistant inbox attachment integrity check failed.')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function publishAttachment(directory: string, path: string, bytes: Buffer): Promise<void> {
  const temp = join(directory, `.tmp.${randomUUID()}`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.chmod(0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    await rename(temp, path)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/** Call within the inbox snapshot serializer and with its directory writer held. */
export function createAssistantInboxAttachments(root: string): AssistantInboxAttachments {
  const directory = join(root, 'attachments')
  const pathFor = (ref: AssistantInboxAttachment): string => {
    const name = `${ref.digest}.image`
    if (!DIGEST_FILE.test(name)) throw new Error('Invalid assistant inbox attachment reference.')
    return join(directory, name)
  }

  return {
    async stage(prepared: readonly PreparedAttachment[]): Promise<void> {
      if (!(await checkedDirectory(directory))) await mkdir(directory, { mode: 0o700 })
      for (const { ref, data } of prepared) {
        const path = pathFor(ref)
        try {
          await readAttachment(path, ref)
        } catch (error) {
          if (!isMissingFile(error)) throw error
          await publishAttachment(directory, path, data)
        }
      }
      // Confirm both a previous uncertain publish and the parent directory link.
      await syncDirectory(directory)
      await syncDirectory(root)
    },

    async load(refs: readonly AssistantInboxAttachment[]): Promise<PromptImageInput[]> {
      if (refs.length === 0) return []
      if (!(await checkedDirectory(directory)))
        throw new Error('Assistant inbox attachments are missing.')
      const images: PromptImageInput[] = []
      for (const ref of refs) {
        const data = await readAttachment(pathFor(ref), ref)
        images.push({ mimeType: ref.mimeType, data: data.toString('base64') })
      }
      return validatePromptImages(images)
    },

    async sweep(retainedDigests: ReadonlySet<string>): Promise<void> {
      if (!(await checkedDirectory(directory))) return
      const files = await readdir(directory, { withFileTypes: true })
      let removed = false
      for (const file of files) {
        if (!file.isFile()) continue
        const digest = DIGEST_FILE.exec(file.name)?.[1]
        if (digest ? retainedDigests.has(digest) : !TEMP_FILE.test(file.name)) continue
        const path = join(directory, file.name)
        if (!isPrivateFile(await lstat(path))) continue
        await unlink(path)
        removed = true
      }
      if (removed) await syncDirectory(directory)
    }
  }
}
