import assert from 'node:assert/strict'
import test from 'node:test'

import type { OfficeCliRunResult } from '../src/main/agent/office/office-driver'
import {
  captureOfficePptxBefore,
  validateOfficePptxOperation,
  type OfficePptxSnapshot,
  type OfficeSetSlideTextOperation
} from '../src/main/agent/office/office-pptx-contract'
import { wrapOfficePptxSnapshot } from '../src/main/agent/office/office-pptx-operation'
import { officePptxLayoutWarning } from '../src/main/agent/office/office-pptx-element'
import { OfficePptxWriter } from '../src/main/agent/office/office-pptx-write'
import { officeWriteStrategy } from '../src/main/agent/office/office-write-operation'

const context = { binaryPath: '/officecli', draftPath: '/draft.pptx' }

test('validates bounded PPTX operations and canonical stable ids', () => {
  assert.deepEqual(validateOfficePptxOperation({ type: 'add_slide', title: '标题', body: '' }), {
    type: 'add_slide',
    title: '标题',
    body: ''
  })
  assert.deepEqual(
    validateOfficePptxOperation({
      type: 'set_slide_text',
      slideId: '000256',
      elementId: '0002',
      text: '新标题',
      expectedText: '旧标题'
    }),
    {
      type: 'set_slide_text',
      slideId: '256',
      elementId: '2',
      text: '新标题',
      expectedText: '旧标题'
    }
  )
  for (const operation of [
    { type: 'add_slide', title: '' },
    { type: 'add_slide', title: 'x'.repeat(201) },
    { type: 'add_slide', title: 'a\nb' },
    { type: 'set_slide_text', slideId: '1', elementId: '2', text: 'x' },
    { type: 'set_slide_text', slideId: '256', elementId: '0', text: 'x' },
    { type: 'set_slide_text', slideId: '256', elementId: '2', text: '' }
  ])
    assert.throws(() => validateOfficePptxOperation(operation), { code: 'invalid_value' })
})

test('adds one slide after a stable slide id and derives its new stable id from the package', async () => {
  const calls: string[][] = []
  const before = snapshot([slide('256', 0, '封面')])
  const writer = new OfficePptxWriter({
    readPackage: async () => presentationPackage(['256', '901']),
    run: async (_binary, args) => {
      calls.push([...args])
      return result({ success: true, data: 'Added slide at /slide[2]' })
    }
  })

  const receipt = await writer.apply(
    context,
    {
      type: 'add_slide',
      title: '第二页',
      body: '正文 & < >',
      position: { after: '256' }
    },
    before
  )

  assert.deepEqual(receipt, {
    type: 'add_slide',
    slideId: '901',
    path: '/slide[@id=901]',
    index: 1
  })
  assert.deepEqual(calls[0], [
    'add',
    '/draft.pptx',
    '/',
    '--type',
    'slide',
    '--after',
    '/slide[1]',
    '--prop',
    'title=第二页',
    '--prop',
    'text=正文 & < >',
    '--json'
  ])
})

test('sets text through the current CLI path only after stable-id and expectedText checks', async () => {
  const calls: string[][] = []
  const before = snapshot([slide('256', 0, '旧标题')])
  const writer = new OfficePptxWriter({
    readPackage: async () => presentationPackage(['256']),
    run: async (_binary, args) => {
      calls.push([...args])
      return result({ success: true, data: 'Updated /slide[1]/shape[@id=2]: text=新标题' })
    }
  })

  const receipt = await writer.apply(context, setTextOperation('新标题', '旧标题'), before)
  assertSetMutation(receipt, calls[0])

  await assert.rejects(writer.apply(context, setTextOperation('x', '过期'), before), {
    code: 'stale_target'
  })
  assert.equal(calls.length, 1)
})

test('rolls back an added slide by stable package id without another get read', async () => {
  const calls: string[][] = []
  const writer = new OfficePptxWriter({
    readPackage: async () => presentationPackage(['256', '901']),
    run: async (_binary, args) => {
      calls.push([...args])
      return result({ success: true, data: 'Removed /slide[2]' })
    }
  })

  await writer.restore(
    context,
    { type: 'add_slide', title: '待回滚' },
    { type: 'add_slide', slideCount: 1, previousSlideId: '256' },
    { type: 'add_slide', slideId: '901', path: '/slide[@id=901]', index: 1 }
  )

  assert.deepEqual(calls, [['remove', '/draft.pptx', '/slide[2]', '--json']])
})

test('restores slide text through the current index resolved from its stable slide id', async () => {
  const calls: string[][] = []
  const writer = new OfficePptxWriter({
    readPackage: async () => presentationPackage(['901', '256']),
    run: async (_binary, args) => {
      calls.push([...args])
      return result({ success: true, data: 'Updated /slide[2]/shape[@id=2]: text=旧标题' })
    }
  })

  await writer.restore(
    context,
    { type: 'set_slide_text', slideId: '256', elementId: '2', text: '新标题' },
    { type: 'set_slide_text', slideId: '256', elementId: '2', text: '旧标题' },
    {
      type: 'set_slide_text',
      slideId: '256',
      elementId: '2',
      path: '/slide[@id=256]/shape[@id=2]'
    }
  )

  assert.deepEqual(calls, [
    ['set', '/draft.pptx', '/slide[2]/shape[@id=2]', '--prop', 'text=旧标题', '--json']
  ])
})

test('captures bounded rollback evidence and rejects non-editable elements and slide overflow', () => {
  const before = snapshot([slide('256', 0, '标题', false)])
  assert.throws(
    () =>
      captureOfficePptxBefore(
        {
          type: 'set_slide_text',
          slideId: '256',
          elementId: '2',
          text: 'x'
        },
        before
      ),
    { code: 'element_not_plain' }
  )

  const full = snapshot(
    Array.from({ length: 200 }, (_, index) => slide(String(256 + index), index, `页${index}`))
  )
  assert.throws(() => captureOfficePptxBefore({ type: 'add_slide', title: '超限' }, full), {
    code: 'too_many_slides'
  })
})

test('builds safe approval text and emits a heuristic layout warning without blocking the write', () => {
  const before = snapshot([slide('256', 0, '旧标题')])
  const operation = {
    type: 'set_slide_text' as const,
    slideId: '256',
    elementId: '2',
    text: '中'.repeat(180)
  }
  const strategy = officeWriteStrategy(operation)
  const request = { operation, baseRevision: 0 }
  const description = strategy.describe(
    request,
    wrapOfficePptxSnapshot(before),
    '演示 & < >.pptx',
    0
  )
  assert.match(strategy.approvalSummary(description), /修改第 1 页标题/)
  assert.doesNotMatch(strategy.approvalSummary(description), /演示 & < >/)

  const current = snapshot([slide('256', 0, operation.text)])
  const receipt = strategy.result(
    request,
    wrapOfficePptxSnapshot(before),
    1,
    true,
    false,
    wrapOfficePptxSnapshot(current)
  )
  assert.equal('layoutWarning' in receipt ? receipt.layoutWarning : undefined, 'text_may_overflow')
  assert.deepEqual(receipt.warnings, ['preview_not_confirmed', 'text_may_overflow'])
})

test('layout warning counts CJK as full-width, ASCII as half-width, with geometry and fallback caps', () => {
  const geometry = { widthPoints: 100, heightPoints: 24, fontSizePoints: 10 }
  assert.equal(officePptxLayoutWarning('a'.repeat(20), 'text', geometry), undefined)
  assert.equal(officePptxLayoutWarning('中'.repeat(21), 'text', geometry), 'text_may_overflow')
  assert.equal(officePptxLayoutWarning('中'.repeat(61), 'title'), 'text_may_overflow')
  assert.equal(officePptxLayoutWarning('a'.repeat(100), 'title'), undefined)
  assert.equal(officePptxLayoutWarning('中'.repeat(601), 'body'), 'text_may_overflow')
})

function snapshot(slides: readonly OfficePptxSnapshot['slides'][number][]): OfficePptxSnapshot {
  return { slides, slideCount: slides.length }
}

function setTextOperation(text: string, expectedText: string): OfficeSetSlideTextOperation {
  return { type: 'set_slide_text' as const, slideId: '256', elementId: '2', text, expectedText }
}

function assertSetMutation(receipt: unknown, args: readonly string[] | undefined): void {
  assert.deepEqual(receipt, {
    type: 'set_slide_text',
    slideId: '256',
    elementId: '2',
    path: '/slide[@id=256]/shape[@id=2]'
  })
  assert.deepEqual(args, [
    'set',
    '/draft.pptx',
    '/slide[1]/shape[@id=2]',
    '--prop',
    'text=新标题',
    '--json'
  ])
}

function slide(
  slideId: string,
  index: number,
  title: string,
  editable = true
): OfficePptxSnapshot['slides'][number] {
  return {
    slideId,
    index,
    title,
    elements: [
      {
        elementId: '2',
        path: `/slide[@id=${slideId}]/shape[@id=2]`,
        cliPath: `/slide[${index + 1}]/shape[@id=2]`,
        kind: 'title',
        text: title,
        editable,
        geometry: { widthPoints: 200, heightPoints: 50, fontSizePoints: 20 }
      }
    ]
  }
}

function presentationPackage(ids: readonly string[]): Buffer {
  const relationships = ids
    .map(
      (_id, index) =>
        `<Relationship Id="r${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide${index + 1}.xml"/>`
    )
    .join('')
  const slideIds = ids.map((id, index) => `<p:sldId id="${id}" r:id="r${index}"/>`).join('')
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

function result(value: unknown): OfficeCliRunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: '',
    timedOut: false,
    truncated: false
  }
}
