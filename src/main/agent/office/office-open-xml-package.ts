import { inflateRawSync } from 'node:zlib'

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_FILE = 0x02014b50
const LOCAL_FILE = 0x04034b50
const MAX_ZIP_COMMENT_BYTES = 65_535

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - MAX_ZIP_COMMENT_BYTES - 22)
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset
  }
  return -1
}

interface OfficePackageEntry {
  readonly name: string
  readonly compression: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localOffset: number
  readonly centralStart: number
}

function assertLocalEntry(bytes: Buffer, entry: OfficePackageEntry): number {
  const { localOffset: offset, name: expectedName } = entry
  if (
    offset < 0 ||
    offset >= entry.centralStart ||
    offset + 30 > entry.centralStart ||
    bytes.readUInt32LE(offset) !== LOCAL_FILE
  ) {
    throw new Error('invalid zip local entry')
  }
  const nameLength = bytes.readUInt16LE(offset + 26)
  const extraLength = bytes.readUInt16LE(offset + 28)
  const dataOffset = offset + 30 + nameLength + extraLength
  const dataEnd = dataOffset + entry.compressedSize
  if (dataEnd > entry.centralStart) throw new Error('invalid zip local entry bounds')
  const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
  if (name !== expectedName) throw new Error('zip entry name mismatch')
  return dataOffset
}

function readCentralEntry(
  bytes: Buffer,
  offset: number,
  end: number,
  centralStart: number
): [OfficePackageEntry, number] {
  if (offset + 46 > end || bytes.readUInt32LE(offset) !== CENTRAL_DIRECTORY_FILE) {
    throw new Error('invalid zip directory entry')
  }
  const nameLength = bytes.readUInt16LE(offset + 28)
  const extraLength = bytes.readUInt16LE(offset + 30)
  const commentLength = bytes.readUInt16LE(offset + 32)
  const next = offset + 46 + nameLength + extraLength + commentLength
  if (next > end) throw new Error('invalid zip entry bounds')
  const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
  const entry = {
    name,
    compression: bytes.readUInt16LE(offset + 10),
    compressedSize: bytes.readUInt32LE(offset + 20),
    uncompressedSize: bytes.readUInt32LE(offset + 24),
    localOffset: bytes.readUInt32LE(offset + 42),
    centralStart
  }
  assertLocalEntry(bytes, entry)
  return [entry, next]
}

function packageEntries(bytes: Buffer): readonly OfficePackageEntry[] {
  const end = findEndOfCentralDirectory(bytes)
  if (end < 0) throw new Error('missing zip directory')
  const count = bytes.readUInt16LE(end + 10)
  if (
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count
  ) {
    throw new Error('unsupported multi-disk zip')
  }
  const size = bytes.readUInt32LE(end + 12)
  const start = bytes.readUInt32LE(end + 16)
  if (start + size !== end) throw new Error('invalid zip directory bounds')
  const entries: OfficePackageEntry[] = []
  const names = new Set<string>()
  let offset = start
  for (let index = 0; index < count; index += 1) {
    const [entry, next] = readCentralEntry(bytes, offset, end, start)
    if (names.has(entry.name)) throw new Error('duplicate zip entry')
    names.add(entry.name)
    entries.push(entry)
    offset = next
  }
  if (offset !== end || offset - start !== size) throw new Error('invalid zip directory size')
  return Object.freeze(entries)
}

export function officePackageEntries(bytes: Buffer): ReadonlySet<string> {
  return new Set(packageEntries(bytes).map((entry) => entry.name))
}

export function officePackageEntry(bytes: Buffer, name: string, maxBytes: number): Buffer {
  const entry = packageEntries(bytes).find((candidate) => candidate.name === name)
  if (!entry) throw new Error('missing zip entry')
  if (entry.uncompressedSize > maxBytes) throw new Error('zip entry too large')
  const offset = assertLocalEntry(bytes, entry)
  const compressed = bytes.subarray(offset, offset + entry.compressedSize)
  const content = decompressEntry(entry.compression, compressed, maxBytes)
  if (content.length !== entry.uncompressedSize || content.length > maxBytes) {
    throw new Error('invalid zip entry size')
  }
  return content
}

function decompressEntry(compression: number, bytes: Buffer, maxBytes: number): Buffer {
  if (compression === 0) {
    if (bytes.length > maxBytes) throw new Error('oversized zip entry')
    return Buffer.from(bytes)
  }
  if (compression === 8) {
    try {
      return inflateRawSync(bytes, { maxOutputLength: maxBytes + 1 })
    } catch {
      throw new Error('invalid or oversized zip entry')
    }
  }
  throw new Error('unsupported zip compression')
}
