import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import { PHI_PLATFORMS } from '../platform'
import { parseTarGz } from '../../packages/archive'
import {
  fetchArtifact,
  installationSpecSha256,
  MAX_EXPANDED_ARCHIVE_BYTES,
  MAX_ARTIFACT_BYTES,
  readTarEntries,
  readVerifiedArtifact,
  safeApplicationRelativePath,
  throwIfAborted
} from './artifacts'
import type {
  ApplicationInstallInput,
  ApplicationInstallResult,
  NativeApplicationArtifact
} from './types'

/** Installs one declared binary; archive contents never become an extracted filesystem tree. */
export async function installNativeApplication(
  input: ApplicationInstallInput
): Promise<ApplicationInstallResult> {
  const spec = input.installation
  if (spec.backend !== 'native')
    throw new Error('native installer requires a native installation spec')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spec.executable))
    throw new Error('invalid native application executable')
  if (!PHI_PLATFORMS.includes(input.platform))
    throw new Error(`unsupported native application platform ${input.platform}`)
  const selected = spec.artifacts[input.platform]
  if (!selected)
    throw new Error(`native application has no artifact for platform ${input.platform}`)
  if (selected.format !== 'file') safeApplicationRelativePath(selected.member)
  throwIfAborted(input.signal)
  input.onProgress?.({ phase: 'application', message: `fetching ${spec.executable}` })
  const artifact = await fetchArtifact(input.root, selected, {
    signal: input.signal,
    fetch: input.fetch
  })
  throwIfAborted(input.signal)
  const archive = readVerifiedArtifact(artifact)
  const binary = nativeArtifactBinary(selected, archive)
  throwIfAborted(input.signal)
  input.onProgress?.({ phase: 'application', message: `installing ${spec.executable}` })
  mkdirSync(input.prefix, { recursive: true, mode: 0o700 })
  assertDirectory(input.prefix)
  const bin = join(input.prefix, 'bin')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  assertDirectory(bin)
  const temporary = join(bin, `.${spec.executable}.${randomUUID()}.partial`)
  try {
    writeFileSync(temporary, binary, { flag: 'wx', mode: 0o700 })
    chmodSync(temporary, 0o700)
    throwIfAborted(input.signal)
    renameSync(temporary, join(bin, spec.executable))
  } finally {
    rmSync(temporary, { force: true })
  }
  return {
    backend: 'native',
    executable: spec.executable,
    specSha256: installationSpecSha256(spec),
    artifacts: [{ key: artifact.key, sha256: artifact.sha256, size: artifact.size }]
  }
}

/** Share exact regular-member selection with declared Bun/Node runtime provisioning. */
export function nativeArtifactBinary(
  selected: NativeApplicationArtifact,
  archive: Buffer,
  options: { allowUnselectedLinks?: boolean } = {}
): Buffer {
  const binary =
    selected.format === 'file'
      ? archive
      : selected.format === 'tar.gz'
        ? tarMember(archive, selected.member, options.allowUnselectedLinks)
        : selected.format === 'zip'
          ? zipMember(archive, selected.member, options.allowUnselectedLinks)
          : unsupportedArchive()
  if (!binary.length) throw new Error('native application executable is empty')
  return binary
}

function unsupportedArchive(): never {
  throw new Error('unsupported native application archive format')
}

function assertDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('native application prefix must not contain symlinks')
}

function tarMember(archive: Buffer, member: string, allowUnselectedLinks = false): Buffer {
  const path = safeApplicationRelativePath(member)
  const entries = allowUnselectedLinks ? runtimeTarEntries(archive) : readTarEntries(archive)
  const selected = entries.find((entry) => entry.path === path)
  if (!selected || selected.type !== 'file')
    throw new Error(`native application archive has no regular member ${member}`)
  return selected.data
}

// Official Node archives include npm/npx links. They are inspected and ignored, never extracted.
function runtimeTarEntries(archive: Buffer): ReturnType<typeof parseTarGz> {
  if (archive.length > MAX_ARTIFACT_BYTES)
    throw new Error('application archive exceeds its size bound')
  const entries = parseTarGz(archive, MAX_EXPANDED_ARCHIVE_BYTES)
  if (entries.length > 10000) throw new Error('application archive has too many members')
  const paths = new Map<string, string>()
  for (const entry of entries) {
    if (entry.type === 'other') throw new Error('application archive contains a special file')
    entry.path = safeApplicationRelativePath(entry.path.replace(/\/$/, ''))
    if (entry.type === 'directory' && entry.size !== 0)
      throw new Error('application archive directory contains data')
    if (paths.has(entry.path)) throw new Error('application archive contains duplicate members')
    paths.set(entry.path, entry.type)
  }
  for (const path of paths.keys()) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) {
      const parent = paths.get(parts.slice(0, index).join('/'))
      if (parent && parent !== 'directory')
        throw new Error('application archive member collides with a file or link')
    }
  }
  return entries
}

interface ZipEntry {
  path: string
  directory: boolean
  link: boolean
  method: number
  crc: number
  compressedSize: number
  size: number
  dataOffset: number
  rangeStart: number
  rangeEnd: number
}

function zipMember(archive: Buffer, member: string, allowUnselectedLinks = false): Buffer {
  const path = safeApplicationRelativePath(member)
  const entries = zipEntries(archive, allowUnselectedLinks)
  const selected = entries.find((entry) => entry.path === path)
  if (!selected || selected.directory || selected.link)
    throw new Error(`native application archive has no regular member ${member}`)
  const compressed = archive.subarray(
    selected.dataOffset,
    selected.dataOffset + selected.compressedSize
  )
  const data =
    selected.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: Math.max(1, selected.size) })
  if (data.length !== selected.size || crc32(data) !== selected.crc)
    throw new Error('native application ZIP member integrity mismatch')
  return data
}

/** ZIP64, encryption, symlinks, special files, overlapping members, and expansion bombs fail closed. */
function zipEntries(archive: Buffer, allowUnselectedLinks: boolean): ZipEntry[] {
  let end = -1
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65557); offset--) {
    if (
      archive.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + archive.readUInt16LE(offset + 20) === archive.length
    ) {
      end = offset
      break
    }
  }
  if (end < 0) throw new Error('invalid native application ZIP directory')
  const count = archive.readUInt16LE(end + 10)
  const directorySize = archive.readUInt32LE(end + 12)
  const directoryOffset = archive.readUInt32LE(end + 16)
  if (
    archive.readUInt16LE(end + 4) !== 0 ||
    archive.readUInt16LE(end + 6) !== 0 ||
    archive.readUInt16LE(end + 8) !== count ||
    count === 0xffff ||
    count > 10000 ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directorySize !== end
  )
    throw new Error('unsupported native application ZIP directory')
  const entries: ZipEntry[] = []
  const paths = new Map<string, boolean>()
  let offset = directoryOffset
  let totalSize = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('invalid native application ZIP entry')
    const flags = archive.readUInt16LE(offset + 8)
    const method = archive.readUInt16LE(offset + 10)
    const crc = archive.readUInt32LE(offset + 16)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const size = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const attributes = archive.readUInt32LE(offset + 38)
    const local = archive.readUInt32LE(offset + 42)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (
      next > end ||
      flags & ~(0x0800 | 0x0008 | 0x0006) ||
      ![0, 8].includes(method) ||
      archive.readUInt16LE(offset + 34) !== 0 ||
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      local === 0xffffffff
    )
      throw new Error('unsupported native application ZIP entry')
    validateZipExtra(
      archive.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength)
    )
    const encodedName = archive.subarray(offset + 46, offset + 46 + nameLength)
    if (!(flags & 0x0800) && encodedName.some((byte) => byte > 0x7f))
      throw new Error('unsupported native application ZIP filename encoding')
    const name = new TextDecoder('utf-8', { fatal: true }).decode(encodedName)
    const directory = name.endsWith('/')
    const path = safeApplicationRelativePath(directory ? name.slice(0, -1) : name)
    const unixType = (attributes >>> 16) & 0xf000
    const link = unixType === 0xa000
    if (
      unixType &&
      unixType !== (directory ? 0x4000 : 0x8000) &&
      !(allowUnselectedLinks && link && !directory)
    )
      throw new Error('native application ZIP contains a link or special file')
    if ((attributes & 0x10) !== 0 && !directory)
      throw new Error('native application ZIP directory type mismatch')
    if (directory && (size || compressedSize))
      throw new Error('native application ZIP directory contains data')
    if (method === 0 && size !== compressedSize)
      throw new Error('native application ZIP stored size mismatch')
    totalSize += size
    if (totalSize > MAX_EXPANDED_ARCHIVE_BYTES)
      throw new Error('native application ZIP exceeds its expanded size bound')
    if (paths.has(path)) throw new Error('native application ZIP contains duplicate members')
    paths.set(path, directory)
    if (local + 30 > directoryOffset || archive.readUInt32LE(local) !== 0x04034b50)
      throw new Error('invalid native application ZIP local entry')
    const localNameLength = archive.readUInt16LE(local + 26)
    const localExtraLength = archive.readUInt16LE(local + 28)
    const dataOffset = local + 30 + localNameLength + localExtraLength
    if (
      archive.readUInt16LE(local + 6) !== flags ||
      archive.readUInt16LE(local + 8) !== method ||
      dataOffset + compressedSize > directoryOffset ||
      localNameLength !== nameLength ||
      !archive.subarray(local + 30, local + 30 + localNameLength).equals(encodedName)
    )
      throw new Error('native application ZIP local entry mismatch')
    validateZipExtra(archive.subarray(local + 30 + localNameLength, dataOffset))
    let rangeEnd = dataOffset + compressedSize
    if (flags & 0x0008) {
      if (rangeEnd + 4 <= directoryOffset && archive.readUInt32LE(rangeEnd) === 0x08074b50)
        rangeEnd += 4
      if (
        rangeEnd + 12 > directoryOffset ||
        archive.readUInt32LE(rangeEnd) !== crc ||
        archive.readUInt32LE(rangeEnd + 4) !== compressedSize ||
        archive.readUInt32LE(rangeEnd + 8) !== size
      )
        throw new Error('native application ZIP data descriptor mismatch')
      rangeEnd += 12
    } else if (
      archive.readUInt32LE(local + 14) !== crc ||
      archive.readUInt32LE(local + 18) !== compressedSize ||
      archive.readUInt32LE(local + 22) !== size
    ) {
      throw new Error('native application ZIP local size mismatch')
    }
    entries.push({
      path,
      directory,
      link,
      method,
      crc,
      compressedSize,
      size,
      dataOffset,
      rangeStart: local,
      rangeEnd
    })
    offset = next
  }
  if (offset !== end) throw new Error('native application ZIP central directory size mismatch')
  for (const path of paths.keys()) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) {
      if (paths.get(parts.slice(0, index).join('/')) === false)
        throw new Error('native application ZIP member collides with a file')
    }
  }
  let previousEnd = 0
  for (const entry of entries.sort((left, right) => left.rangeStart - right.rangeStart)) {
    if (entry.rangeStart < previousEnd)
      throw new Error('native application ZIP has overlapping members')
    previousEnd = entry.rangeEnd
  }
  return entries
}

function validateZipExtra(extra: Buffer): void {
  let offset = 0
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw new Error('invalid native application ZIP extra field')
    const tag = extra.readUInt16LE(offset)
    const size = extra.readUInt16LE(offset + 2)
    if (tag === 0x0001 || offset + 4 + size > extra.length)
      throw new Error('unsupported native application ZIP extra field')
    offset += 4 + size
  }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  return crc >>> 0
})

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}
