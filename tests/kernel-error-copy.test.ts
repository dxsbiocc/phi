import assert from 'node:assert/strict'
import test from 'node:test'

import { protocolErrorCodes } from '../src/shared/kernel-protocol'
import {
  kernelErrorPresentation,
  kernelRecoveryActions,
  localizeKernelError
} from '../src/renderer/src/features/chat/lib/kernelErrorCopy'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

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
