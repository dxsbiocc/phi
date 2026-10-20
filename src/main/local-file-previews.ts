import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'

import { listLocalProjectAllowRoots } from './agent/projects'
import {
  hoverMediaPreviewType,
  mediaPreviewType,
  type PreviewImageMimeType
} from './file-preview-media'
import type { createLocalFileAccessControl } from './local-file-access-control'

const FILE_PREVIEW_BYTES_LIMIT = 320000
const FILE_MEDIA_PREVIEW_BYTES_LIMIT = 10 * 1024 * 1024
const FILE_HTML_PREVIEW_BYTES_LIMIT = 10 * 1024 * 1024
const FILE_HOVER_TEXT_BYTES_LIMIT = 32 * 1024
const FILE_HOVER_IMAGE_BYTES_LIMIT = 2 * 1024 * 1024
const FILE_HOVER_SNIFF_BYTES_LIMIT = 512

type FilePreviewBasePayload = {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  bytes: number
  previewBytes: number
  truncated: boolean
}

type FilePreviewPayload = FilePreviewBasePayload &
  (
    | {
        kind: 'text'
        mimeType: 'text/plain'
        content: string
      }
    | {
        kind: 'html'
        mimeType: 'text/html'
        content: string
      }
    | {
        kind: 'image'
        mimeType: PreviewImageMimeType
        dataUrl: string
      }
    | {
        kind: 'pdf'
        mimeType: 'application/pdf'
        dataUrl: string
      }
  )

type FileHoverPreviewPayload = FilePreviewBasePayload &
  (
    | {
        kind: 'text'
        mimeType: 'text/plain'
        content: string
      }
    | {
        kind: 'spreadsheet'
        mimeType: 'text/csv' | 'text/tab-separated-values'
        format: 'csv' | 'tsv'
        content: string
      }
    | {
        kind: 'image'
        mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
        dataUrl: string
      }
    | {
        kind: 'metadata'
        mimeType: string
        reason: 'binary' | 'large_file' | 'pdf' | 'unsupported_media'
      }
  )

export function createLocalFilePreviews(
  access: Pick<
    ReturnType<typeof createLocalFileAccessControl>,
    'assertLocalFilePathAllowed' | 'assertFileHoverPreviewPathAllowed' | 'getLocalPathScope'
  >
): {
  createFilePreview: (filePath: string) => FilePreviewPayload
  createFileHoverPreview: (filePath: string) => FileHoverPreviewPayload
} {
  return new LocalFilePreviewReader(access)
}

class LocalFilePreviewReader {
  constructor(
    private readonly access: Pick<
      ReturnType<typeof createLocalFileAccessControl>,
      'assertLocalFilePathAllowed' | 'assertFileHoverPreviewPathAllowed' | 'getLocalPathScope'
    >
  ) {}

  private readFilePreviewBytes(target: string, bytesToRead: number): Buffer {
    if (bytesToRead <= 0) return Buffer.alloc(0)

    const fd = openSync(target, 'r')
    try {
      const buffer = Buffer.alloc(bytesToRead)
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      closeSync(fd)
    }
  }

  private filePreviewBasePayload(
    target: string,
    stats: { size: number },
    previewBytes: number,
    truncated: boolean
  ): FilePreviewBasePayload {
    const scope = this.access.getLocalPathScope(target, listLocalProjectAllowRoots())
    return {
      path: target,
      name: basename(target),
      displayPath: scope?.displayPath ?? basename(target),
      rootPath: scope?.rootPath ?? dirname(target),
      rootLabel: scope?.rootLabel ?? basename(dirname(target)),
      bytes: stats.size,
      previewBytes,
      truncated
    }
  }

  private spreadsheetHoverPreviewType(
    path: string
  ):
    | { format: 'csv'; mimeType: 'text/csv' }
    | { format: 'tsv'; mimeType: 'text/tab-separated-values' }
    | null {
    const name = basename(path).toLowerCase()
    if (name.endsWith('.csv')) return { format: 'csv', mimeType: 'text/csv' }
    if (name.endsWith('.tsv') || name.endsWith('.tab')) {
      return { format: 'tsv', mimeType: 'text/tab-separated-values' }
    }
    return null
  }

  createFilePreview(filePath: string): FilePreviewPayload {
    const target = this.access.assertLocalFilePathAllowed(filePath, '预览', {
      resolveSymlinks: true
    })
    const stats = statSync(target)
    if (!stats.isFile()) {
      throw new Error('只能预览文件内容')
    }

    const truncated = stats.size > FILE_PREVIEW_BYTES_LIMIT
    const previewBytes = this.readFilePreviewBytes(
      target,
      Math.min(stats.size, FILE_PREVIEW_BYTES_LIMIT)
    )
    const base = this.filePreviewBasePayload(target, stats, previewBytes.byteLength, truncated)
    const mediaType = mediaPreviewType(previewBytes)
    if (mediaType) {
      if (stats.size > FILE_MEDIA_PREVIEW_BYTES_LIMIT) {
        throw new Error('文件过大，暂不支持直接预览')
      }
      const mediaBytes =
        previewBytes.byteLength === stats.size
          ? previewBytes
          : this.readFilePreviewBytes(target, stats.size)
      if (mediaType.kind === 'image') {
        return {
          ...base,
          kind: 'image',
          mimeType: mediaType.mimeType,
          dataUrl: `data:${mediaType.mimeType};base64,${mediaBytes.toString('base64')}`,
          previewBytes: mediaBytes.byteLength,
          truncated: false
        }
      }

      return {
        ...base,
        kind: 'pdf',
        mimeType: 'application/pdf',
        dataUrl: `data:${mediaType.mimeType};base64,${mediaBytes.toString('base64')}`,
        previewBytes: mediaBytes.byteLength,
        truncated: false
      }
    }

    if (previewBytes.includes(0)) {
      throw new Error('暂不支持预览二进制文件')
    }

    if (/\.html?$/i.test(target) && stats.size <= FILE_HTML_PREVIEW_BYTES_LIMIT) {
      const htmlBytes =
        previewBytes.byteLength === stats.size
          ? previewBytes
          : this.readFilePreviewBytes(target, stats.size)
      return {
        ...base,
        kind: 'html',
        mimeType: 'text/html',
        content: htmlBytes.toString('utf8'),
        previewBytes: htmlBytes.byteLength,
        truncated: false
      }
    }

    return {
      ...base,
      kind: 'text',
      mimeType: 'text/plain',
      content: previewBytes.toString('utf8'),
      truncated
    }
  }

  createFileHoverPreview(filePath: string): FileHoverPreviewPayload {
    const target = this.access.assertFileHoverPreviewPathAllowed(filePath)
    const stats = statSync(target)
    if (!stats.isFile()) {
      throw new Error('只能预览文件内容')
    }

    const sniffBytes = this.readFilePreviewBytes(
      target,
      Math.min(stats.size, FILE_HOVER_SNIFF_BYTES_LIMIT)
    )
    const base = this.filePreviewBasePayload(
      target,
      stats,
      sniffBytes.byteLength,
      stats.size > sniffBytes.byteLength
    )
    const mediaType = hoverMediaPreviewType(sniffBytes)

    if (mediaType?.kind === 'image') {
      if (stats.size > FILE_HOVER_IMAGE_BYTES_LIMIT) {
        return {
          ...base,
          kind: 'metadata',
          mimeType: mediaType.mimeType,
          reason: 'large_file',
          truncated: true
        }
      }

      const mediaBytes =
        sniffBytes.byteLength === stats.size
          ? sniffBytes
          : this.readFilePreviewBytes(target, stats.size)
      return {
        ...base,
        kind: 'image',
        mimeType: mediaType.mimeType,
        dataUrl: `data:${mediaType.mimeType};base64,${mediaBytes.toString('base64')}`,
        previewBytes: mediaBytes.byteLength,
        truncated: false
      }
    }

    if (mediaType?.kind === 'pdf') {
      return {
        ...base,
        kind: 'metadata',
        mimeType: 'application/pdf',
        reason: 'pdf',
        truncated: stats.size > sniffBytes.byteLength
      }
    }

    if (sniffBytes.includes(0)) {
      return {
        ...base,
        kind: 'metadata',
        mimeType: 'application/octet-stream',
        reason: 'binary',
        truncated: stats.size > sniffBytes.byteLength
      }
    }

    const previewBytes =
      sniffBytes.byteLength >= Math.min(stats.size, FILE_HOVER_TEXT_BYTES_LIMIT)
        ? sniffBytes
        : this.readFilePreviewBytes(target, Math.min(stats.size, FILE_HOVER_TEXT_BYTES_LIMIT))
    const truncated = stats.size > previewBytes.byteLength
    const spreadsheetType = this.spreadsheetHoverPreviewType(target)
    if (spreadsheetType) {
      return {
        ...this.filePreviewBasePayload(target, stats, previewBytes.byteLength, truncated),
        kind: 'spreadsheet',
        mimeType: spreadsheetType.mimeType,
        format: spreadsheetType.format,
        content: previewBytes.toString('utf8')
      }
    }

    return {
      ...this.filePreviewBasePayload(target, stats, previewBytes.byteLength, truncated),
      kind: 'text',
      mimeType: 'text/plain',
      content: previewBytes.toString('utf8')
    }
  }
}
