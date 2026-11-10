import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import {
  resourceCategoryLabel,
  resourceSourceLabel,
  websiteSourceLabel
} from '../src/renderer/src/lib/resourceUi'

afterEach(() => setUiLanguage('en'))

test('unknown author labels are preserved even when they match object prototype names', () => {
  for (const label of ['自定义实验分组', '__proto__', 'constructor', 'toString', '']) {
    assert.equal(resourceCategoryLabel(label), label)
    assert.equal(resourceSourceLabel(label), label)
  }
})

test('display translations leave catalog identifiers and author content unchanged', () => {
  const entry = {
    id: 'group:science',
    groupLabel: '科学分析',
    title: '作者的工具名称',
    summary: '作者提供的说明'
  }
  const before = { ...entry }
  assert.equal(resourceCategoryLabel(entry.groupLabel), 'Scientific Analysis')
  assert.deepEqual(entry, before)
})

test('website source labels distinguish website rows from registry fallback rows', () => {
  for (const source of ['', 'Phi Packages', '  Phi Packages  ']) {
    assert.equal(websiteSourceLabel(source), 'Phi Website')
  }
  assert.equal(websiteSourceLabel('Mirror source'), 'Phi Website · Mirror source')

  setUiLanguage('zh-CN')
  for (const source of ['', 'Phi Packages']) {
    assert.equal(websiteSourceLabel(source), 'Phi 官网')
  }
  assert.equal(websiteSourceLabel('Mirror source'), 'Phi 官网 · Mirror source')
})
