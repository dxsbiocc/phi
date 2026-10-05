import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { assertOfficeDocxPackage } from '../src/main/agent/office/office-docx-package'
import { officeKindAdapter } from '../src/main/agent/office/office-kind-adapters'

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

test('accepts a DOCX package with the required Open XML parts', () => {
  const bytes = storedZip({
    '[Content_Types].xml': '<Types/>',
    '_rels/.rels': '<Relationships/>',
    'word/document.xml': '<w:document/>'
  })

  assert.doesNotThrow(() => assertOfficeDocxPackage(bytes))
})

test('rejects a DOCX package without word/document.xml', () => {
  const bytes = storedZip({
    '[Content_Types].xml': '<Types/>',
    '_rels/.rels': '<Relationships/>',
    'xl/workbook.xml': '<workbook/>'
  })

  assert.throws(() => assertOfficeDocxPackage(bytes), /docx package part/)
})

test('rejects a malformed DOCX ZIP directory', () => {
  assert.throws(() => assertOfficeDocxPackage(Buffer.from('not-a-zip')), /zip directory/)
})

test('rejects packages whose Open XML structure does not match the requested kind', () => {
  const xlsx = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx'))
  const docx = storedZip({
    '[Content_Types].xml': '<Types/>',
    '_rels/.rels': '<Relationships/>',
    'word/document.xml': '<w:document/>'
  })

  assert.throws(() => officeKindAdapter('docx').assertPackage(xlsx), /docx package part/)
  assert.throws(() => officeKindAdapter('xlsx').assertPackage(docx), /xlsx package part/)
})
