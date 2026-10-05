import assert from 'node:assert/strict'
import test from 'node:test'

import { OFFICE_PRESENTATION_LIMITS } from '../src/main/agent/office/office-limits'
import {
  assertOfficePptxPackage,
  OfficePptxPackageError
} from '../src/main/agent/office/office-pptx-package'

function storedZip(entries: Readonly<Record<string, string>>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let localOffset = 0
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name)
    const contentBytes = Buffer.from(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt32LE(contentBytes.length, 18)
    local.writeUInt32LE(contentBytes.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, contentBytes)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt32LE(contentBytes.length, 20)
    directory.writeUInt32LE(contentBytes.length, 24)
    directory.writeUInt16LE(nameBytes.length, 28)
    directory.writeUInt32LE(localOffset, 42)
    central.push(directory, nameBytes)
    localOffset += local.length + nameBytes.length + contentBytes.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

const presentationParts = (slides: number): Readonly<Record<string, string>> =>
  Object.fromEntries([
    ['[Content_Types].xml', '<Types/>'],
    ['_rels/.rels', '<Relationships/>'],
    ['ppt/presentation.xml', '<p:presentation/>'],
    ...Array.from({ length: slides }, (_, index) => [
      `ppt/slides/slide${index + 1}.xml`,
      '<p:sld/>'
    ])
  ])

test('accepts a zero-slide PPTX package without inventing a slide part', () => {
  assert.doesNotThrow(() => assertOfficePptxPackage(storedZip(presentationParts(0))))
})

test('reports a typed missing_part error for absent presentation metadata', () => {
  const bytes = storedZip({
    '[Content_Types].xml': '<Types/>',
    '_rels/.rels': '<Relationships/>'
  })

  assert.throws(
    () => assertOfficePptxPackage(bytes),
    (error: unknown) => error instanceof OfficePptxPackageError && error.code === 'missing_part'
  )
})

test('rejects non-contiguous PPTX slide part numbering', () => {
  const parts = {
    ...presentationParts(1),
    'ppt/slides/slide3.xml': '<p:sld/>'
  }

  assert.throws(
    () => assertOfficePptxPackage(storedZip(parts)),
    (error: unknown) => error instanceof OfficePptxPackageError && error.code === 'invalid_slides'
  )
})

test('caps admitted PPTX packages at 200 slides', () => {
  assert.equal(OFFICE_PRESENTATION_LIMITS.maxSlides, 200)
  assert.doesNotThrow(() => assertOfficePptxPackage(storedZip(presentationParts(200))))
  assert.throws(
    () => assertOfficePptxPackage(storedZip(presentationParts(201))),
    (error: unknown) =>
      Boolean(error instanceof OfficePptxPackageError && error.code === 'too_many_slides')
  )
})

test('rejects malformed PPTX ZIP directories before checking package parts', () => {
  assert.throws(() => assertOfficePptxPackage(Buffer.from('not-a-zip')), /zip directory/)
})
