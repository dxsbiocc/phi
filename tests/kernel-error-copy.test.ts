import assert from 'node:assert/strict'
import test from 'node:test'

import { protocolErrorCodes } from '../src/shared/kernel-protocol'
import {
  kernelErrorPresentation,
  kernelRecoveryActions
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
