import { createHash } from 'node:crypto'
import type { PhiExtensionBundle } from './types'

const TAR_BLOCK_BYTES = 512

function writeAscii(target: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'ascii')
  if (bytes.length > length) throw new Error('Phi extension archive field is too long')
  bytes.copy(target, offset)
}

function octal(value: number, length: number): string {
  const digits = value.toString(8)
  if (digits.length > length - 1) throw new Error('Phi extension archive value is too large')
  return `${digits.padStart(length - 1, '0')}\0`
}

function ustarPath(path: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(path, 'ascii') <= 100) return { name: path, prefix: '' }
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
    const prefix = path.slice(0, slash)
    const name = path.slice(slash + 1)
    if (Buffer.byteLength(prefix, 'ascii') <= 155 && Buffer.byteLength(name, 'ascii') <= 100)
      return { name, prefix }
  }
  return undefined
}

function paxPathRecord(path: string): Buffer {
  const body = `path=${path}\n`
  let length = Buffer.byteLength(body) + 2
  for (;;) {
    const next = Buffer.byteLength(body) + String(length).length + 1
    if (next === length) return Buffer.from(`${length} ${body}`, 'ascii')
    length = next
  }
}

function header(path: string, size: number, type: '0' | 'x', prefix = ''): Buffer {
  const result = Buffer.alloc(TAR_BLOCK_BYTES)
  writeAscii(result, 0, 100, path)
  writeAscii(result, 100, 8, octal(0o600, 8))
  writeAscii(result, 108, 8, octal(0, 8))
  writeAscii(result, 116, 8, octal(0, 8))
  writeAscii(result, 124, 12, octal(size, 12))
  writeAscii(result, 136, 12, octal(0, 12))
  result.fill(0x20, 148, 156)
  result[156] = type.charCodeAt(0)
  writeAscii(result, 257, 6, 'ustar\0')
  writeAscii(result, 263, 2, '00')
  writeAscii(result, 329, 8, octal(0, 8))
  writeAscii(result, 337, 8, octal(0, 8))
  writeAscii(result, 345, 155, prefix)
  const checksum = result.reduce((sum, byte) => sum + byte, 0)
  writeAscii(result, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return result
}

function appendEntry(chunks: Buffer[], path: string, bytes: Buffer, index: number): void {
  let selected = ustarPath(path)
  if (!selected) {
    const pax = paxPathRecord(path)
    chunks.push(header(`PaxHeaders/${index}`, pax.length, 'x'), pax)
    const paxPadding = (TAR_BLOCK_BYTES - (pax.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
    if (paxPadding) chunks.push(Buffer.alloc(paxPadding))
    selected = { name: `PaxFiles/${index}`, prefix: '' }
  }
  chunks.push(header(selected.name, bytes.length, '0', selected.prefix), bytes)
  const padding = (TAR_BLOCK_BYTES - (bytes.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
  if (padding) chunks.push(Buffer.alloc(padding))
}

/** Deterministic POSIX tar snapshot used as the deployment transfer source. */
export function createPhiExtensionArchive(
  bundle: PhiExtensionBundle,
  manifest: Buffer
): { bytes: Buffer; sha256: string } {
  const chunks: Buffer[] = []
  const files = [
    ...[...bundle.files].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    { path: 'manifest.json', bytes: manifest }
  ]
  files.forEach((file, index) => appendEntry(chunks, file.path, file.bytes, index))
  chunks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2))
  const bytes = Buffer.concat(chunks)
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}
