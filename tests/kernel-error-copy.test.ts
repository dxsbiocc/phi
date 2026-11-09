import assert from 'node:assert/strict'
import test from 'node:test'

import { protocolErrorCodes } from '../src/shared/kernel-protocol'
import {
  kernelErrorPresentation,
  kernelRecoveryActions,
  localizeKernelError,
  localizeKernelHistoryMissingMessage
} from '../src/renderer/src/features/chat/lib/kernelErrorCopy'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

const movedDataDirectoryError =
  "[PHI_KERNEL:CAPABILITY_UNAVAILABLE] The conversation's kernel history was not found in the current data directory (it was recorded under /old/path). The requested session was not found. [reason:kernel_history_missing] [recorded:%2Fold%2Fpath]"

test('every closed kernel protocol code has an English and Chinese action message', () => {
  for (const language of ['en', 'zh-CN'] as const) {
    setUiLanguage(language)
    for (const code of protocolErrorCodes) {
      const value = kernelErrorPresentation(new Error(`[PHI_KERNEL:${code}] raw transport text`))
      assert.ok(value, `${language}/${code}`)
      assert.equal(value.code, code)
      assert.equal(value.action, kernelRecoveryActions[code])
      assert.ok(value.message.length > 3)
      assert.ok(value.actionLabel.length > 2)
      assert.doesNotMatch(value.message, /raw transport text/u)
    }
  }
  setUiLanguage('en')
})

test('remote lease-unavailable model copy explains the project scope and retains detail', () => {
  const detail = 'Selected remote kernel model is unavailable.'
  const wrapped = new Error(`IPC prompt failed: ${detail}`)

  setUiLanguage('en')
  const english = localizeKernelError(wrapped)
  assert.ok(english instanceof Error)
  assert.match(english.message, /another model for this remote project/u)
  assert.match(english.message, new RegExp(detail.replace('.', '\\.'), 'u'))

  setUiLanguage('zh-CN')
  const chinese = localizeKernelError(wrapped)
  assert.ok(chinese instanceof Error)
  assert.match(chinese.message, /不适用于远程项目，请选择其他模型/u)
  assert.match(chinese.message, new RegExp(detail.replace('.', '\\.'), 'u'))

  setUiLanguage('en')
})

test('moved data-directory kernel history errors name the recorded path in English and Chinese', () => {
  setUiLanguage('en')
  assert.equal(
    localizeKernelHistoryMissingMessage(movedDataDirectoryError),
    "This conversation's history was not found in the current data directory. It was recorded under /old/path."
  )
  const english = localizeKernelError(new Error(movedDataDirectoryError))
  assert.ok(english instanceof Error)
  assert.equal(
    english.message,
    "This conversation's history was not found in the current data directory. It was recorded under /old/path."
  )

  setUiLanguage('zh-CN')
  assert.equal(
    localizeKernelHistoryMissingMessage(movedDataDirectoryError),
    '在当前数据目录中找不到这段对话的历史记录（原记录位于 /old/path）。'
  )
  const chinese = localizeKernelError(new Error(movedDataDirectoryError))
  assert.ok(chinese instanceof Error)
  assert.equal(
    chinese.message,
    '在当前数据目录中找不到这段对话的历史记录（原记录位于 /old/path）。'
  )

  setUiLanguage('en')
})

test('an unrelated CAPABILITY_UNAVAILABLE error keeps its current text', () => {
  const raw = '[PHI_KERNEL:CAPABILITY_UNAVAILABLE] The requested session was not found.'
  setUiLanguage('en')
  assert.equal(localizeKernelHistoryMissingMessage(raw), undefined)
  const localized = localizeKernelError(new Error(raw))
  assert.ok(localized instanceof Error)
  assert.equal(
    localized.message,
    'This kernel capability is unavailable for the chat. Reopen the chat.'
  )
  setUiLanguage('en')
})
