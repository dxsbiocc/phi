import assert from 'node:assert/strict'
import test from 'node:test'

import { resourceCategoryLabel, resourceSourceLabel } from '../src/renderer/src/lib/resourceUi'

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
