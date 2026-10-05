import assert from 'node:assert/strict'
import test from 'node:test'

import type { OfficeCliRunResult } from '../src/main/agent/office/office-driver'
import { OfficePptxReader } from '../src/main/agent/office/office-pptx-read'
import { parseOfficePptxElement } from '../src/main/agent/office/office-pptx-element'
import { readOfficePptxSlideIds } from '../src/main/agent/office/office-pptx-identity'
import { OfficeReadError } from '../src/main/agent/office/office-read-contract'

const context = {
  artifactId: 'artifact-pptx',
  binaryPath: '/officecli',
  draftPath: '/draft.pptx',
  revision: 7
}

test('reads PPTX slides with stable slide/shape ids and conservative editable flags', async () => {
  const reader = pptxReader([
    slideNode(1, [shapeNode(1, 2, 'title', '标题'), shapeNode(1, 3, 'body', '正文', 2)]),
    slideNode(2, [shapeNode(2, 4, 'text', '普通文本')])
  ])

  const result = await reader.read(context, { limit: 2 })

  assert.equal(result.revision, 7)
  assert.equal(result.total, 2)
  assert.equal(result.complete, true)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.slides[0], {
    slideId: '256',
    index: 0,
    title: '标题',
    elements: [
      {
        elementId: '2',
        path: '/slide[@id=256]/shape[@id=2]',
        kind: 'title',
        text: '标题',
        editable: true,
        truncated: false
      },
      {
        elementId: '3',
        path: '/slide[@id=256]/shape[@id=3]',
        kind: 'body',
        text: '正文',
        editable: false,
        truncated: false
      }
    ]
  })
  assert.equal(result.slides[1]?.slideId, '901')
})

test('paginates PPTX reads with a revision-bound HMAC cursor', async () => {
  const reader = pptxReader([
    slideNode(1, [shapeNode(1, 2, 'title', '一')]),
    slideNode(2, [shapeNode(2, 2, 'title', '二')])
  ])
  const first = await reader.read(context, { from: 0, limit: 1 })
  assert.equal(first.complete, false)
  assert.equal(first.truncated, true)
  assert.ok(first.nextCursor)

  const second = await reader.read(context, { cursor: first.nextCursor })
  assert.deepEqual(
    second.slides.map((slide) => slide.slideId),
    ['901']
  )
  assert.equal(second.complete, true)

  await assert.rejects(
    reader.read({ ...context, revision: 8 }, { cursor: first.nextCursor }),
    (error: unknown) => error instanceof OfficeReadError && error.code === 'invalid_cursor'
  )
  await assert.rejects(
    reader.read({ ...context, artifactId: 'other-artifact' }, { cursor: first.nextCursor }),
    (error: unknown) => error instanceof OfficeReadError && error.code === 'invalid_cursor'
  )
  await assert.rejects(
    reader.read(context, { cursor: `${first.nextCursor}x` }),
    (error: unknown) => error instanceof OfficeReadError && error.code === 'invalid_cursor'
  )
})

test('truncates oversized PPTX element text on UTF-8 boundaries and makes it non-editable', async () => {
  const reader = pptxReader([slideNode(1, [shapeNode(1, 2, 'body', '中'.repeat(4_000))])])
  const result = await reader.read(context, {})
  const element = result.slides[0]?.elements[0]

  assert.equal(element?.truncated, true)
  assert.equal(element?.editable, false)
  assert.ok(Buffer.byteLength(element?.text ?? '', 'utf8') <= 8 * 1024)
  assert.equal(result.truncated, true)
})

test('rejects spreadsheet parameters and out-of-range page limits for PPTX', async () => {
  const reader = pptxReader([])
  for (const params of [{ sheet: 'Sheet1' }, { range: 'A1' }, { maxCells: 1 }, { limit: 51 }]) {
    await assert.rejects(
      reader.read(context, params),
      (error: unknown) => error instanceof OfficeReadError && error.code === 'invalid_arguments'
    )
  }
})

test('canonicalizes package slide ids and rejects ambiguous relationship identity', () => {
  assert.deepEqual(
    readOfficePptxSlideIds(
      packageFromXml(
        '<p:sldId id="0000000256" r:id="r1"/>',
        '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide1.xml"/>'
      )
    ),
    ['256']
  )
  assert.throws(
    () =>
      readOfficePptxSlideIds(
        packageFromXml(
          '<p:sldId id="256" r:id="r1"/><p:sldId id="257" r:id="r1"/>',
          '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide1.xml"/>'
        )
      ),
    /identity/
  )
  assert.throws(
    () =>
      readOfficePptxSlideIds(
        packageFromXml(
          '<p:sldId id="256" r:id="r1"/>',
          '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide1.xml"/><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide2.xml"/>'
        )
      ),
    /duplicate/
  )
})

test('editable detection distrusts childCount lies and shape paths bound to another slide', () => {
  const malformed = shapeNode(1, 2, 'title', '标题', 2)
  const paragraph = (malformed.children as Record<string, unknown>[])[0]!
  paragraph.childCount = 1
  assert.equal(parseOfficePptxElement(malformed, '256', 1)?.editable, false)

  const wrongSlide = shapeNode(2, 2, 'title', '标题')
  assert.throws(() => parseOfficePptxElement(wrongSlide, '256', 1), /shape identity/)
  const oversizedId = shapeNode(1, 2, 'title', '标题')
  ;(oversizedId.format as Record<string, unknown>).id = 0x1_0000_0000
  assert.throws(() => parseOfficePptxElement(oversizedId, '256', 1), /shape identity/)
})

test('editable detection rejects multiple paragraphs, fields, CRLF, C0/C1 controls, but permits plain TAB', () => {
  const multiParagraph = shapeNode(1, 2, 'body', '两段')
  multiParagraph.childCount = 2
  multiParagraph.children = [
    ...(multiParagraph.children as unknown[]),
    ...(multiParagraph.children as unknown[])
  ]
  assert.equal(parseOfficePptxElement(multiParagraph, '256', 1)?.editable, false)

  const field = shapeNode(1, 2, 'body', '字段')
  const paragraph = (field.children as Record<string, unknown>[])[0]!
  ;(paragraph.children as Record<string, unknown>[])[0]!.type = 'field'
  assert.equal(parseOfficePptxElement(field, '256', 1)?.editable, false)

  for (const text of ['a\r\nb', 'a\u0001b', 'a\u0085b']) {
    assert.equal(parseOfficePptxElement(shapeNode(1, 2, 'body', text), '256', 1)?.editable, false)
  }
  assert.equal(parseOfficePptxElement(shapeNode(1, 2, 'body', 'a\tb'), '256', 1)?.editable, true)
})

function pptxReader(slides: readonly Record<string, unknown>[]): OfficePptxReader {
  return new OfficePptxReader({
    cursorSecret: Buffer.alloc(32, 7),
    readPackage: async () => presentationPackage(slides.length),
    run: async () =>
      cliResult({
        success: true,
        data: {
          results: [
            { path: '/', type: 'presentation', childCount: slides.length, children: slides }
          ]
        }
      })
  })
}

function slideNode(
  index: number,
  children: readonly Record<string, unknown>[]
): Record<string, unknown> {
  return { path: `/slide[${index}]`, type: 'slide', childCount: children.length, children }
}

function shapeNode(
  slide: number,
  id: number,
  kind: 'title' | 'body' | 'text',
  text: string,
  runs = 1
): Record<string, unknown> {
  const children = Array.from({ length: runs }, (_, index) => ({
    path: `/slide[${slide}]/shape[@id=${id}]/paragraph[1]/run[${index + 1}]`,
    type: 'run',
    text: runs === 1 ? text : `${index}`,
    childCount: 0,
    children: []
  }))
  return {
    path: `/slide[${slide}]/shape[@id=${id}]`,
    type: kind === 'body' ? 'placeholder' : kind,
    text,
    childCount: 1,
    format: {
      id,
      phType: kind === 'text' ? undefined : kind,
      width: '720pt',
      height: '100pt',
      'effective.size': '20pt'
    },
    children: [{ type: 'paragraph', text, childCount: runs, children }]
  }
}

function presentationPackage(slides: number): Buffer {
  const relationships = Array.from({ length: slides }, (_, index) => {
    const id = index === 0 ? 'rSlideA' : `rSlide${index}`
    return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide${index + 1}.xml"/>`
  }).join('')
  const ids = Array.from({ length: slides }, (_, index) => {
    const id = index === 0 ? 256 : 900 + index
    const relationship = index === 0 ? 'rSlideA' : `rSlide${index}`
    return `<p:sldId r:id="${relationship}" id="${id}"/>`
  }).join('')
  return storedZip({
    'ppt/presentation.xml': `<p:presentation><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships>${relationships}</Relationships>`
  })
}

function packageFromXml(slideIds: string, relationships: string): Buffer {
  return storedZip({
    'ppt/presentation.xml': `<p:presentation><p:sldIdLst>${slideIds}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships>${relationships}</Relationships>`
  })
}

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

function cliResult(value: unknown): OfficeCliRunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: '',
    timedOut: false,
    truncated: false
  }
}
