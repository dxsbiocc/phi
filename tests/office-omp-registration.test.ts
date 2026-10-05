import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'

const bunAvailable = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0

interface SmokeMode {
  permissionMode?: string
  names?: string[]
  read?: { payload?: { complete?: boolean } }
  apply?: { payload?: { applied?: boolean; revision?: number } }
  denied?: { payload?: { code?: string; message?: string }; isError?: boolean }
  docxRead?: { payload?: { total?: number; untrustedParagraphData?: unknown[] } }
  docxApply?: { payload?: { paraId?: string; applied?: boolean } }
  pptxRead?: { payload?: { total?: number; untrustedSlideData?: unknown[] } }
  pptxApply?: { payload?: { slideId?: string; title?: string; applied?: boolean } }
  pptxSet?: {
    payload?: { slideId?: string; elementId?: string; after?: string; applied?: boolean }
  }
  pptxDenied?: { payload?: { code?: string; message?: string }; isError?: boolean }
  deliver?: {
    payload?: {
      fileName?: string
      outputPath?: string
      kind?: string
      revision?: number
      sha256?: string
      size?: number
      warnings?: string[]
      checks?: unknown[]
    }
  }
  deliverDenied?: { payload?: { code?: string; message?: string }; isError?: boolean }
  deliverParams?: unknown
  deliverContext?: unknown
  deliverDeniedContext?: unknown
  docxApplyParams?: unknown
  docxApplyContext?: unknown
  pptxApplyParams?: unknown
  pptxApplyContext?: unknown
  pptxSetParams?: unknown
  pptxSetContext?: unknown
  pptxDeniedContext?: unknown
  applyParams?: unknown
  applyContext?: unknown
  deniedContext?: unknown
  askEventToolCallIds?: string[]
}

test(
  'real OMP SDK preserves Office toolCallId in ask, auto and full modes without a model',
  { skip: !bunAvailable },
  () => {
    const output = runSmoke()
    assert.equal(output.modes?.length, 3)
    for (const permissionMode of ['ask', 'auto', 'full'] as const) {
      const mode = output.modes?.find((item) => item.permissionMode === permissionMode)
      assert.ok(mode)
      assertSpreadsheetMode(mode, permissionMode)
      assertDocxMode(mode, permissionMode)
      assertPptxMode(mode, permissionMode)
      assertDeliverMode(mode, permissionMode)
      assert.deepEqual(mode.askEventToolCallIds, expectedAskIds(permissionMode))
    }
  }
)

function runSmoke(): { modes?: SmokeMode[] } {
  const result = spawnSync(
    'bun',
    [join(process.cwd(), 'tests', 'helpers', 'officeOmpToolSmoke.ts')],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 }
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as { modes?: SmokeMode[] }
}

function assertSpreadsheetMode(mode: SmokeMode, permissionMode: string): void {
  assert.deepEqual(mode.names, ['office_read', 'office_apply', 'office_deliver'])
  assert.equal(mode.read?.payload?.complete, true)
  assert.deepEqual(mode.applyParams, {
    operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: permissionMode },
    baseRevision: 3
  })
  assert.deepEqual(mode.applyContext, { toolCallId: `office-${permissionMode}-apply` })
  assert.deepEqual(mode.deniedContext, { toolCallId: `office-${permissionMode}-denied` })
  assert.equal(mode.apply?.payload?.applied, true)
  assert.equal(mode.apply?.payload?.revision, 4)
  assert.equal(mode.denied?.payload?.code, 'approval_denied')
  assert.match(mode.denied?.payload?.message ?? '', /用户未批准.*未做任何修改/u)
  assert.equal(mode.denied?.isError, true)
}

function assertDeliverMode(mode: SmokeMode, permissionMode: string): void {
  assert.deepEqual(mode.deliverParams, { outputName: '交付成果' })
  assert.deepEqual(mode.deliverContext, {
    toolCallId: `office-${permissionMode}-deliver`
  })
  assert.deepEqual(mode.deliverDeniedContext, {
    toolCallId: `office-${permissionMode}-deliver-denied`
  })
  assert.deepEqual(mode.deliver?.payload, {
    fileName: '交付成果.xlsx',
    outputPath: '交付成果.xlsx',
    kind: 'xlsx',
    revision: 9,
    sha256: 'a'.repeat(64),
    size: 4096,
    warnings: ['布局截图检查不可用'],
    checks: [
      { name: 'schema', status: 'passed' },
      { name: 'xlsx_content', status: 'passed', sampled: 1 }
    ]
  })
  assert.equal(mode.deliverDenied?.payload?.code, 'approval_denied')
  assert.match(mode.deliverDenied?.payload?.message ?? '', /用户未批准交付.*未创建文件/u)
  assert.equal(mode.deliverDenied?.isError, true)
}

function assertDocxMode(mode: SmokeMode, permissionMode: string): void {
  assert.equal(mode.docxRead?.payload?.total, 1)
  assert.equal(mode.docxRead?.payload?.untrustedParagraphData?.length, 1)
  assert.deepEqual(mode.docxApplyParams, {
    operation: { type: 'add_paragraph', text: 'OMP 新段落', position: 'end' },
    baseRevision: 4
  })
  assert.deepEqual(mode.docxApplyContext, {
    toolCallId: `office-${permissionMode}-docx-apply`
  })
  assert.equal(mode.docxApply?.payload?.applied, true)
  assert.equal(mode.docxApply?.payload?.paraId, '0010000B')
}

function assertPptxMode(mode: SmokeMode, permissionMode: string): void {
  assert.equal(mode.pptxRead?.payload?.total, 1)
  assert.equal(mode.pptxRead?.payload?.untrustedSlideData?.length, 1)
  assert.deepEqual(mode.pptxApplyParams, {
    operation: {
      type: 'add_slide',
      title: 'OMP PPTX 新页面',
      body: 'OMP PPTX 正文',
      position: 'end'
    },
    baseRevision: 6
  })
  assert.deepEqual(mode.pptxApplyContext, {
    toolCallId: `office-${permissionMode}-pptx-apply`
  })
  assert.deepEqual(mode.pptxSetParams, {
    operation: {
      type: 'set_slide_text',
      slideId: '256',
      elementId: '2',
      text: 'OMP PPTX 更新标题',
      expectedText: 'OMP PPTX 标题'
    },
    baseRevision: 7
  })
  assert.deepEqual(mode.pptxSetContext, {
    toolCallId: `office-${permissionMode}-pptx-set`
  })
  assert.deepEqual(mode.pptxDeniedContext, {
    toolCallId: `office-${permissionMode}-pptx-denied`
  })
  assert.equal(mode.pptxApply?.payload?.applied, true)
  assert.equal(mode.pptxApply?.payload?.slideId, '256')
  assert.equal(mode.pptxApply?.payload?.title, 'OMP PPTX 新页面')
  assert.equal(mode.pptxSet?.payload?.applied, true)
  assert.equal(mode.pptxSet?.payload?.slideId, '256')
  assert.equal(mode.pptxSet?.payload?.elementId, '2')
  assert.equal(mode.pptxSet?.payload?.after, 'OMP PPTX 更新标题')
  assert.equal(mode.pptxDenied?.payload?.code, 'approval_denied')
  assert.match(mode.pptxDenied?.payload?.message ?? '', /用户未批准.*未做任何修改/u)
  assert.equal(mode.pptxDenied?.isError, true)
}

function expectedAskIds(permissionMode: string): string[] {
  return permissionMode === 'ask'
    ? [
        'apply',
        'denied',
        'docx-apply',
        'pptx-apply',
        'pptx-set',
        'pptx-denied',
        'deliver',
        'deliver-denied'
      ].map((suffix) => `office-${permissionMode}-${suffix}`)
    : []
}
