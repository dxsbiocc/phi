import assert from 'node:assert/strict'
import test from 'node:test'
import { readableErrorMessage } from '../src/renderer/src/lib/sessionNotifications'

test('readableErrorMessage removes Electron remote method wrapper', () => {
  assert.equal(
    readableErrorMessage(
      "Error invoking remote method 'thinking:select': Error: 会话运行中，思考等级将在停止或完成后才能切换",
      '切换思考等级失败'
    ),
    '会话运行中，思考等级将在停止或完成后才能切换'
  )
})
