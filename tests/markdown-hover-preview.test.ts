import assert from 'node:assert/strict'
import test from 'node:test'

import { describeLocalFileHoverError } from '../src/renderer/src/lib/markdownLocalPathPreview'

test('hover preview turns the project boundary failure into actionable settings guidance', () => {
  const description = describeLocalFileHoverError(
    new Error(
      "Error invoking remote method 'files:hoverPreview': Error: 此文件位于当前项目之外。请前往“设置 → 通用”，开启“允许读取项目外文件”后重试。"
    )
  )

  assert.deepEqual(description, {
    title: '无法预览项目外文件',
    message: '为保护本地文件，Phi 默认只读取当前项目或 Phi 保存的文件。',
    action: '前往“设置 → 通用”，开启“允许读取项目外文件”后重试。'
  })
})

test('hover preview removes Electron IPC prefixes from ordinary failures', () => {
  const description = describeLocalFileHoverError(
    new Error("Error invoking remote method 'files:hoverPreview': Error: 文件不存在")
  )

  assert.deepEqual(description, {
    title: '无法预览文件',
    message: '文件不存在'
  })
})
