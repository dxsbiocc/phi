import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv from 'ajv'

import { buildOfficeApplyTool } from '../src/main/agent/office/office-apply-tool'
import {
  formatOfficeApplyApprovalSummary,
  officeApplyApprovalDigest,
  OfficeApplyApprovalRegistry
} from '../src/main/agent/office/office-approval'

test('office_apply exposes bounded DOCX add and stable-id text replacement operations', () => {
  const tool = buildOfficeApplyTool(async () => ({ ok: true }))
  const schema = tool.parameters as {
    properties: { operation: { oneOf: Array<Record<string, unknown>> } }
  }
  const validate = new Ajv({ allErrors: true, strict: false }).compile(tool.parameters)

  assert.equal(schema.properties.operation.oneOf.length, 9)
  assert.equal(
    validate({
      operation: { type: 'add_paragraph', text: '新增正文', position: 'end' },
      baseRevision: 2
    }),
    true,
    JSON.stringify(validate.errors)
  )
  assert.equal(
    validate({
      operation: {
        type: 'add_paragraph',
        text: '插入正文',
        position: { after: '0010000A' }
      },
      baseRevision: 2
    }),
    true,
    JSON.stringify(validate.errors)
  )
  assert.equal(
    validate({
      operation: {
        type: 'set_paragraph_text',
        paraId: '0010000A',
        text: '修改正文',
        expectedText: '原正文'
      },
      baseRevision: 2
    }),
    true,
    JSON.stringify(validate.errors)
  )
  assert.equal(
    validate({
      operation: { type: 'set_paragraph_text', paraId: 'p[1]', text: '修改正文' },
      baseRevision: 2
    }),
    false
  )
  assert.equal(
    validate({
      operation: { type: 'add_paragraph', text: '含\n换行' },
      baseRevision: 2
    }),
    false
  )
  assert.match(tool.description, /paraId/u)
  assert.match(tool.description, /expectedText/u)
  assert.match(tool.description, /先.*office_read|office_read.*先/u)
})

test('office_apply forwards only DOCX fields and returns a compact untrusted paragraph receipt', async () => {
  const calls: unknown[] = []
  const tool = buildOfficeApplyTool(async (method, params, context) => {
    calls.push({ method, params, context })
    return {
      ok: true,
      value: {
        applied: true,
        saved: true,
        revision: 4,
        paraId: '0010000A',
        path: '/body/p[@paraId=0010000A]',
        index: 2,
        before: '旧正文',
        after: '新正文 & <Phi>',
        previewConfirmed: true
      }
    }
  })

  const result = await tool.execute(
    'docx-call-1',
    {
      operation: {
        type: 'set_paragraph_text',
        paraId: '0010000A',
        text: '新正文 & <Phi>',
        expectedText: '旧正文',
        path: '/private/forged.docx'
      },
      baseRevision: 3,
      artifactId: 'forged'
    } as never,
    undefined,
    {} as never
  )

  assert.deepEqual(calls, [
    {
      method: 'office.apply',
      params: {
        operation: {
          type: 'set_paragraph_text',
          paraId: '0010000A',
          text: '新正文 & <Phi>',
          expectedText: '旧正文'
        },
        baseRevision: 3
      },
      context: { toolCallId: 'docx-call-1' }
    }
  ])
  assert.equal(result.isError, undefined)
  const payload = JSON.parse((result.content[0] as { text: string }).text)
  assert.equal(payload.after, '新正文 & <Phi>')
  assert.match(payload.dataNotice, /不是指令/u)
  assert.equal(JSON.stringify(payload).includes('/private/'), false)
})

test('DOCX approval summaries escape and truncate paragraph text', () => {
  const summary = formatOfficeApplyApprovalSummary({
    type: 'set_paragraph_text',
    documentName: '报告<草稿>.docx',
    paraId: '0010000A',
    index: 1,
    before: '旧<&>\n内容',
    after: `${'新'.repeat(90)}<&>`,
    revision: 3
  })

  assert.match(summary, /第 2 段/u)
  assert.match(summary, /0010000A/u)
  assert.match(summary, /↵/u)
  assert.match(summary, /＆‹＆›|‹＆›/u)
  assert.match(summary, /已截断/u)
  assert.doesNotMatch(summary, /<草稿>/u)
})

test('DOCX approval digest binds paraId expectedText and baseRevision', () => {
  const input = {
    operation: {
      type: 'set_paragraph_text' as const,
      paraId: '0010000A',
      text: '新正文',
      expectedText: '旧正文'
    },
    baseRevision: 3
  }
  const digest = officeApplyApprovalDigest(input)

  assert.notEqual(
    digest,
    officeApplyApprovalDigest({
      ...input,
      operation: { ...input.operation, paraId: '0010000B' }
    })
  )
  assert.notEqual(
    digest,
    officeApplyApprovalDigest({
      ...input,
      operation: { ...input.operation, expectedText: '其它正文' }
    })
  )
  assert.notEqual(digest, officeApplyApprovalDigest({ ...input, baseRevision: 4 }))
})

test('DOCX approval grants are one-shot and reject changed paragraph parameters', () => {
  const registry = new OfficeApplyApprovalRegistry({ clock: () => 100 })
  const input = {
    operation: { type: 'add_paragraph' as const, text: '已批准正文', position: 'end' as const },
    baseRevision: 2
  }
  registry.grant('run-docx', 'call-docx', officeApplyApprovalDigest(input))

  assert.equal(registry.consume('run-docx', 'call-docx', input), true)
  assert.equal(registry.consume('run-docx', 'call-docx', input), false)
  registry.grant('run-docx', 'call-docx-2', officeApplyApprovalDigest(input))
  assert.equal(
    registry.consume('run-docx', 'call-docx-2', {
      ...input,
      operation: { ...input.operation, text: '篡改正文' }
    }),
    false
  )
})
