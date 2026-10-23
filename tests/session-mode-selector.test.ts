import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { SessionModeSelector } from '../src/renderer/src/features/plan/components/SessionModeSelector'
import {
  applySessionModeUpdate,
  requestSessionModeUpdate
} from '../src/renderer/src/features/plan/hooks/useSessionMode'
import { availableSessionModes } from '../src/renderer/src/features/plan/lib/sessionModeView'
import type { CurrentSession } from '../src/renderer/src/types'

test('session mode selector exposes five local modes and hides planning modes remotely', () => {
  assert.deepEqual(availableSessionModes(false), ['auto', 'ask', 'plan', 'plan_execute', 'full'])
  assert.deepEqual(availableSessionModes(true), ['auto', 'ask', 'full'])

  setUiLanguage('zh-CN')
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(SessionModeSelector, {
        mode: 'plan_execute',
        remote: false,
        onSelectMode: () => undefined
      })
    )
  )
  assert.match(markup, /aria-label="选择工作模式：规划并执行"/)
  assert.match(markup, />规划并执行</)
})

test('session mode update forwards the selected mode and exact session target', async () => {
  const target = {
    sessionPath: 'phi-session:session-a',
    phiSessionId: 'session-a',
    sessionGeneration: 3
  }
  const current = {
    path: target.sessionPath,
    phiSessionId: target.phiSessionId,
    cwd: '/project',
    sessionGeneration: target.sessionGeneration,
    permissionMode: 'auto',
    workMode: 'plan_execute',
    status: 'idle',
    unreadKind: null
  } satisfies CurrentSession
  const calls: unknown[][] = []
  const result = await requestSessionModeUpdate(
    {
      updateCurrentSessionMode: async (...args) => {
        calls.push(args)
        return current
      }
    },
    'plan_execute',
    target
  )

  assert.equal(result, current)
  assert.deepEqual(calls, [['plan_execute', target]])
})

test('a rejected session mode update reports the error and keeps the selector value unchanged', async () => {
  const target = {
    sessionPath: 'phi-session:session-a',
    phiSessionId: 'session-a',
    sessionGeneration: 3
  }
  const confirmedMode = 'ask' as const
  const errors: unknown[] = []

  await applySessionModeUpdate({
    api: {
      updateCurrentSessionMode: async () => {
        throw new Error('计划或后台智能体仍在运行，请先暂停或等待结束后再切换模式')
      }
    },
    mode: 'plan_execute',
    target,
    isCurrentTarget: () => true,
    onUpdated: () => {
      assert.fail('a rejected update must not replace the confirmed renderer mode')
    },
    onError: (error) => errors.push(error)
  })

  assert.equal(confirmedMode, 'ask')
  assert.equal(
    (errors[0] as Error).message,
    '计划或后台智能体仍在运行，请先暂停或等待结束后再切换模式'
  )
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(SessionModeSelector, {
        mode: confirmedMode,
        remote: false,
        onSelectMode: () => undefined
      })
    )
  )
  assert.match(markup, /aria-label="选择工作模式：询问"/)
  assert.match(markup, />询问</)
})

test('a rejected update from a replaced session does not show an error in the new session', async () => {
  let currentTarget = true
  const errors: unknown[] = []

  await applySessionModeUpdate({
    api: {
      updateCurrentSessionMode: async () => {
        currentTarget = false
        throw new Error('旧会话模式更新失败')
      }
    },
    mode: 'plan',
    target: {
      sessionPath: 'phi-session:session-a',
      phiSessionId: 'session-a',
      sessionGeneration: 3
    },
    isCurrentTarget: () => currentTarget,
    onUpdated: () => assert.fail('a rejected update must not be applied'),
    onError: (error) => errors.push(error)
  })

  assert.deepEqual(errors, [])
})

test('a late confirmed update from a replaced session is not applied to the new session', async () => {
  let currentTarget = true
  const applied: unknown[] = []

  await applySessionModeUpdate({
    api: {
      updateCurrentSessionMode: async () => {
        currentTarget = false
        return { permissionMode: 'full' } as never
      }
    },
    mode: 'full',
    target: {
      sessionPath: 'phi-session:session-a',
      phiSessionId: 'session-a',
      sessionGeneration: 3
    },
    isCurrentTarget: () => currentTarget,
    onUpdated: (current) => applied.push(current),
    onError: (error) => assert.fail(String(error))
  })

  assert.deepEqual(applied, [])
})
