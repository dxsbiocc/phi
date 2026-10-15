import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import type {
  RuntimeRecoveryApi,
  RuntimeRecoveryState,
  RuntimeRecoveryTarget
} from '../src/shared/runtimeRecoveryTypes'
import * as recoveryState from '../src/renderer/src/features/chat/lib/runtimeRecoveryState'

test('recovery banner: a confirmed connection shows a failed UI refresh without offering another SDK recovery', () => {
  const require = createRequire(import.meta.url)
  const target: RuntimeRecoveryTarget = {
    sessionId: 'A',
    projectId: 'P',
    sessionPath: 'phi-session:A',
    sessionGeneration: 1
  }
  const state: RuntimeRecoveryState = {
    target,
    phase: 'connected',
    canResume: false,
    message: '原会话已恢复'
  }
  let error: string | null = '原会话已恢复，但界面刷新未完成。'
  const recovery = (): ReturnType<
    typeof import('../src/renderer/src/features/chat/hooks/useRuntimeRecovery').useRuntimeRecovery
  > => ({
    state,
    pending: false,
    error,
    refresh: async () => undefined,
    resume: async () => undefined,
    continueFromSummary: async () => undefined
  })
  const source = ts.transpileModule(
    readFileSync('src/renderer/src/features/chat/components/RuntimeRecoveryBanner.tsx', 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX
      }
    }
  ).outputText
  const exported = { exports: {} as Record<string, unknown> }
  runInNewContext(source, {
    module: exported,
    exports: exported.exports,
    require: (name: string) => {
      if (name === '../hooks/useRuntimeRecovery') return { useRuntimeRecovery: recovery }
      if (name === '../lib/runtimeRecoveryState') return recoveryState
      return require(name)
    }
  })
  const Banner = exported.exports
    .RuntimeRecoveryBanner as typeof import('../src/renderer/src/features/chat/components/RuntimeRecoveryBanner').RuntimeRecoveryBanner
  const api: RuntimeRecoveryApi = {
    getRuntimeRecoveryState: async () => state,
    resumeRuntimeSession: async () => state,
    continueRuntimeFromSummary: async () => {
      throw new Error('SSR cannot create a new session')
    }
  }
  const failed = renderToStaticMarkup(createElement(Banner, { api, target }))
  assert.match(failed, /会话已连接/)
  assert.match(failed, /重新打开/)
  assert.match(failed, /界面刷新未完成/)
  assert.doesNotMatch(failed, /恢复原会话|用此摘要新建会话/)
  error = null
  assert.equal(renderToStaticMarkup(createElement(Banner, { api, target })), '')
})
