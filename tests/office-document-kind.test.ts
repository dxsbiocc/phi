import assert from 'node:assert/strict'
import test from 'node:test'

import {
  officeArtifactKind,
  officeDocumentKindFromPath,
  parseOfficeDocumentKind
} from '../src/main/agent/office/office-document-kind'
import { officeKindAdapter } from '../src/main/agent/office/office-kind-adapters'

test('infers an Office document kind from a case-insensitive file extension', () => {
  assert.equal(officeDocumentKindFromPath('/project/report.XLSX'), 'xlsx')
  assert.equal(officeDocumentKindFromPath('/project/brief.DoCx'), 'docx')
  assert.equal(officeDocumentKindFromPath('/project/slides.PpTx'), 'pptx')
})

test('defaults legacy artifact records without a kind to xlsx', () => {
  assert.equal(officeArtifactKind({ artifactId: 'legacy' }), 'xlsx')
  assert.equal(officeArtifactKind({ artifactId: 'word', kind: 'docx' }), 'docx')
  assert.equal(officeArtifactKind({ artifactId: 'slides', kind: 'pptx' }), 'pptx')
})

test('accepts only supported Office document kinds', () => {
  assert.equal(parseOfficeDocumentKind(undefined), 'xlsx')
  assert.equal(parseOfficeDocumentKind('xlsx'), 'xlsx')
  assert.equal(parseOfficeDocumentKind('docx'), 'docx')
  assert.equal(parseOfficeDocumentKind('pptx'), 'pptx')
  assert.throws(() => parseOfficeDocumentKind('pdf'), /文档类型/)
})

test('rejects unsupported Office file extensions', () => {
  assert.throws(() => officeDocumentKindFromPath('/project/report.pdf'), /\.xlsx|\.docx/)
})

test('defines kind-specific capabilities without treating preview-only kinds as globally read-only', () => {
  assert.deepEqual(
    {
      extension: officeKindAdapter('xlsx').extension,
      humanEdit: officeKindAdapter('xlsx').humanEdit,
      defaultName: officeKindAdapter('xlsx').defaultName
    },
    { extension: '.xlsx', humanEdit: 'cells', defaultName: '空白表格.xlsx' }
  )
  assert.deepEqual(
    {
      extension: officeKindAdapter('docx').extension,
      humanEdit: officeKindAdapter('docx').humanEdit,
      defaultName: officeKindAdapter('docx').defaultName
    },
    { extension: '.docx', humanEdit: 'none', defaultName: '未命名文档.docx' }
  )
  assert.deepEqual(
    {
      extension: officeKindAdapter('pptx').extension,
      humanEdit: officeKindAdapter('pptx').humanEdit,
      defaultName: officeKindAdapter('pptx').defaultName
    },
    { extension: '.pptx', humanEdit: 'none', defaultName: '未命名演示文稿.pptx' }
  )
})
