import { gunzipSync, gzipSync } from 'node:zlib'

export interface ArchiveFile {
  path: string
  data: Buffer
  mode?: number
}

export interface TarEntry {
  path: string
  type: 'file' | 'directory' | 'link' | 'other'
  data: Buffer
  size: number
  mode: number
}

const BLOCK_SIZE = 512

/** Build the small deterministic ustar subset used by Phi packages. */
export function createDeterministicTarGz(files: ArchiveFile[]): Buffer {
  const chunks: Buffer[] = []
  for (const file of [...files].sort((left, right) => compareText(left.path, right.path))) {
    const header = tarHeader(file.path, file.data.length, file.mode ?? 0o644)
    chunks.push(header, file.data)
    const padding = (BLOCK_SIZE - (file.data.length % BLOCK_SIZE)) % BLOCK_SIZE
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2))
  return gzipSync(Buffer.concat(chunks), { level: 9 })
}

/** Parse tar metadata without writing anything, so callers can validate paths before extraction. */
export function parseTarGz(archive: Buffer): TarEntry[] {
  let tar: Buffer
  try {
    tar = gunzipSync(archive)
  } catch (error) {
    throw new Error(`invalid gzip archive: ${errorMessage(error)}`)
  }

  const entries: TarEntry[] = []
  let offset = 0
  let nextPath: string | undefined
  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE)
    if (header.every((byte) => byte === 0)) return entries
    verifyChecksum(header)

    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const headerPath = prefix ? `${prefix}/${name}` : name
    const size = readOctal(header, 124, 12, 'size')
    const mode = readOctal(header, 100, 8, 'mode') & 0o777
    const typeFlag = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset + BLOCK_SIZE
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new Error(`truncated tar entry '${headerPath}'`)

    const data = Buffer.from(tar.subarray(dataStart, dataEnd))
    const nextOffset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
    if (typeFlag === 'x') {
      nextPath = parsePaxPath(data) ?? nextPath
      offset = nextOffset
      continue
    }
    if (typeFlag === 'L') {
      nextPath = data.toString('utf8').replace(/[\0\n]+$/, '')
      offset = nextOffset
      continue
    }

    const path = nextPath ?? headerPath
    nextPath = undefined

    let type: TarEntry['type']
    if (typeFlag === '\0' || typeFlag === '0') type = 'file'
    else if (typeFlag === '5') type = 'directory'
    else if (typeFlag === '1' || typeFlag === '2') type = 'link'
    else type = 'other'
    entries.push({ path, type, data, size, mode })

    offset = nextOffset
  }
  throw new Error('tar archive is missing its end marker')
}

function parsePaxPath(data: Buffer): string | undefined {
  let offset = 0
  let path: string | undefined
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space < 0) throw new Error('invalid pax record length')
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10)
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset + 1 ||
      offset + length > data.length
    ) {
      throw new Error('invalid pax record')
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0 && record.slice(0, equals) === 'path') path = record.slice(equals + 1)
    offset += length
  }
  return path
}

function tarHeader(path: string, size: number, mode: number): Buffer {
  const { name, prefix } = splitUstarPath(path)
  const header = Buffer.alloc(BLOCK_SIZE)
  writeString(header, name, 0, 100)
  writeOctal(header, mode & 0o777, 100, 8)
  writeOctal(header, 0, 108, 8)
  writeOctal(header, 0, 116, 8)
  writeOctal(header, size, 124, 12)
  writeOctal(header, 0, 136, 12)
  header.fill(0x20, 148, 156)
  header[156] = '0'.charCodeAt(0)
  writeString(header, 'ustar', 257, 6)
  writeString(header, '00', 263, 2)
  writeString(header, prefix, 345, 155)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  const checksumText = checksum.toString(8).padStart(6, '0')
  header.write(checksumText, 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  const bytes = Buffer.byteLength(path)
  if (bytes <= 100) return { name: path, prefix: '' }
  const slashes = [...path.matchAll(/\//g)].map((match) => match.index ?? -1).reverse()
  for (const index of slashes) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix }
    }
  }
  throw new Error(`archive path is too long for ustar: ${path}`)
}

function writeString(buffer: Buffer, value: string, offset: number, length: number): void {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.length > length) throw new Error(`tar field is too long: ${value}`)
  encoded.copy(buffer, offset)
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid tar number: ${value}`)
  const text = value.toString(8).padStart(length - 1, '0')
  if (text.length >= length) throw new Error(`tar number is too large: ${value}`)
  buffer.write(text, offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

function readString(buffer: Buffer, offset: number, length: number): string {
  const field = buffer.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end >= 0 ? end : field.length).toString('utf8')
}

function readOctal(buffer: Buffer, offset: number, length: number, label: string): number {
  const text = readString(buffer, offset, length).trim()
  if (!/^[0-7]*$/.test(text)) throw new Error(`invalid tar ${label}`)
  const value = text ? Number.parseInt(text, 8) : 0
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid tar ${label}`)
  return value
}

function verifyChecksum(header: Buffer): void {
  const expected = readOctal(header, 148, 8, 'checksum')
  const copy = Buffer.from(header)
  copy.fill(0x20, 148, 156)
  const actual = copy.reduce((sum, byte) => sum + byte, 0)
  if (actual !== expected) throw new Error('invalid tar header checksum')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
