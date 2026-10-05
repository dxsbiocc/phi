import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { OfficeRestoreAlert } from '../src/renderer/src/features/office/components/OfficeRestoreAlert'

test('recovered Office drafts distinguish unexported changes', () => {
  const unchanged = renderToStaticMarkup(
    createElement(OfficeRestoreAlert, {
      status: 'recovered'
    })
  )
  assert.match(unchanged, /data-phi-office-restore-recovered="true"/u)
  assert.match(unchanged, /已恢复本会话草稿/u)
  assert.doesNotMatch(unchanged, /含未另存的修改/u)

  const modified = renderToStaticMarkup(
    createElement(OfficeRestoreAlert, {
      status: 'recovered',
      hasUnsavedChanges: true
    })
  )
  assert.match(modified, /已恢复本会话草稿（含未另存的修改），原文件未改动/u)
})

test('a changed source reports that the new and old drafts are both preserved', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeRestoreAlert, {
      status: 'source_changed'
    })
  )

  assert.match(markup, /data-phi-office-restore-source-changed="true"/u)
  assert.match(markup, /源文件已变化，已基于最新源文件创建新草稿；旧草稿仍保留/u)
})

test('a missing source-backed draft offers a controlled fresh-copy action', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeRestoreAlert, {
      status: 'draft_missing',
      sourceAvailable: true,
      onRecreateFromSource: () => undefined
    })
  )

  assert.match(markup, /data-phi-office-restore-error="draft_missing"/u)
  assert.match(markup, /草稿文件已丢失/u)
  assert.match(markup, /data-phi-office-restore-fresh="true"/u)
  assert.match(markup, />从原文件重新创建草稿</u)
})

test('a corrupt draft is identified and can be recreated only from its source', () => {
  const sourceBacked = renderToStaticMarkup(
    createElement(OfficeRestoreAlert, {
      status: 'draft_corrupt',
      sourceAvailable: true,
      onRecreateFromSource: () => undefined
    })
  )
  assert.match(sourceBacked, /data-phi-office-restore-error="draft_corrupt"/u)
  assert.match(sourceBacked, /草稿文件已损坏，无法作为有效 XLSX 打开/u)
  assert.match(sourceBacked, /data-phi-office-restore-fresh="true"/u)

  const blank = renderToStaticMarkup(
    createElement(OfficeRestoreAlert, {
      status: 'draft_corrupt'
    })
  )
  assert.doesNotMatch(blank, /data-phi-office-restore-fresh/u)
  assert.doesNotMatch(blank, /从原文件重新创建草稿/u)
})

test('a corrupt DOCX draft reports its own package type', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeRestoreAlert, {
      status: 'draft_corrupt',
      kind: 'docx'
    })
  )

  assert.match(markup, /草稿文件已损坏，无法作为有效 DOCX 打开/u)
  assert.doesNotMatch(markup, /XLSX/u)
})

test('a corrupt PPTX draft reports its own package type', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeRestoreAlert, {
      status: 'draft_corrupt',
      kind: 'pptx'
    })
  )

  assert.match(markup, /草稿文件已损坏，无法作为有效 PPTX 打开/u)
  assert.doesNotMatch(markup, /XLSX|DOCX/u)
})

test('an oversized registered draft shows the shared 25 MB recovery error', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeRestoreAlert, {
      status: 'draft_too_large',
      kind: 'docx',
      sourceAvailable: true,
      onRecreateFromSource: () => undefined
    })
  )

  assert.match(markup, /data-phi-office-restore-error="draft_too_large"/u)
  assert.match(markup, /25 MB/u)
  assert.match(markup, /从原文件重新创建草稿/u)
})

test('a draft hash mismatch explains the frozen state and offers a fresh copy', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeRestoreAlert, {
      status: 'draft_hash_mismatch',
      sourceAvailable: true,
      onRecreateFromSource: () => undefined
    })
  )

  assert.match(markup, /data-phi-office-restore-error="draft_hash_mismatch"/u)
  assert.match(markup, /草稿文件与最后一次确认保存的内容不一致，需要核对/u)
  assert.match(markup, /写入与交付已冻结/u)
  assert.match(markup, /data-phi-office-restore-fresh="true"/u)
})

test('an unverified stale process instructs the user without offering to recreate', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeRestoreAlert, {
      status: 'stale_process_unverified',
      sourceAvailable: true,
      onRecreateFromSource: () => undefined
    })
  )

  assert.match(markup, /data-phi-office-restore-stale-process="unverified"/u)
  assert.match(markup, /检测到可能属于该草稿的残留进程，但无法确认/u)
  assert.match(markup, /请退出残留进程后重试/u)
  assert.doesNotMatch(markup, /data-phi-office-restore-fresh/u)
})

test('a corrupt operation log is explicit and remains eligible for a source-backed fresh copy', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeRestoreAlert, {
      status: 'operation_log_corrupt',
      sourceAvailable: true,
      onRecreateFromSource: () => undefined
    })
  )

  assert.match(markup, /data-phi-office-restore-error="operation_log_corrupt"/u)
  assert.match(markup, /草稿写入记录已损坏/u)
  assert.match(markup, /data-phi-office-restore-fresh="true"/u)
})
