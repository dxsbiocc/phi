import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import test from 'node:test'

import {
  officePackageEntries,
  officePackageEntry
} from '../src/main/agent/office/office-open-xml-package'

test('rejects duplicate ZIP entry names before PPTX identity lookup', () => {
  const bytes = zip([
    { name: 'ppt/presentation.xml', content: Buffer.from('one'), compression: 0 },
    { name: 'ppt/presentation.xml', content: Buffer.from('two'), compression: 0 }
  ])
  assert.throws(() => officePackageEntries(bytes), /duplicate zip entry/)
})

test('caps deflate output even when the central directory understates uncompressed size', () => {
  const content = Buffer.alloc(64 * 1024, 65)
  const bytes = zip([{ name: 'ppt/presentation.xml', content, compression: 8, declaredSize: 8 }])
  assert.throws(() => officePackageEntry(bytes, 'ppt/presentation.xml', 1024), /oversized|size/)
})

test('rejects stored entries whose copied payload exceeds the caller bound', () => {
  const bytes = zip([
    {
      name: 'ppt/presentation.xml',
      content: Buffer.alloc(2048, 65),
      compression: 0,
      declaredSize: 8
    }
  ])
  assert.throws(() => officePackageEntry(bytes, 'ppt/presentation.xml', 1024), /oversized|size/)
})

test('rejects unsupported ZIP compression methods', () => {
  const bytes = zip([
    { name: 'ppt/presentation.xml', content: Buffer.from('xml'), compression: 99 }
  ])
  assert.throws(() => officePackageEntry(bytes, 'ppt/presentation.xml', 1024), /compression/)
})

test('rejects multi-disk metadata and local payloads overlapping the central directory', () => {
  const multiDisk = zip([
    { name: 'ppt/presentation.xml', content: Buffer.from('xml'), compression: 0 }
  ])
  multiDisk.writeUInt16LE(1, multiDisk.length - 22 + 4)
  assert.throws(() => officePackageEntries(multiDisk), /multi-disk/)

  const overlapping = zip([
    { name: 'ppt/presentation.xml', content: Buffer.from('xml'), compression: 0 }
  ])
  const end = overlapping.length - 22
  const centralStart = overlapping.readUInt32LE(end + 16)
  overlapping.writeUInt32LE(1024, centralStart + 20)
  assert.throws(() => officePackageEntries(overlapping), /local entry bounds/)
})

interface ZipInput {
  readonly name: string
  readonly content: Buffer
  readonly compression: 0 | 8 | 99
  readonly declaredSize?: number
}

function zip(entries: readonly ZipInput[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const payload = entry.compression === 8 ? deflateRawSync(entry.content) : entry.content
    const declaredSize = entry.declaredSize ?? entry.content.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(entry.compression, 8)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(declaredSize, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, payload)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(entry.compression, 10)
    directory.writeUInt32LE(payload.length, 20)
    directory.writeUInt32LE(declaredSize, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(localOffset, 42)
    central.push(directory, name)
    localOffset += local.length + name.length + payload.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}
