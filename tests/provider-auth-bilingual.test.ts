import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { afterEach } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { ProviderAuthState } from '../src/renderer/src/useProviderAuth'
import type { ProviderAuthStatus } from '../src/renderer/src/types'
import { getUiLanguage, setUiLanguage } from '../src/renderer/src/lib/i18n'
import { readableErrorMessage } from '../src/renderer/src/lib/sessionNotifications'
import { settingsUi } from '../src/renderer/src/features/settings/lib/settingsUi'

afterEach(() => setUiLanguage('en'))

type AuthApi = Pick<
  Window['api'],
  'getAuthStatus' | 'loginApiKey' | 'loginOAuth' | 'logout' | 'submitAuthInteraction'
>

const statuses: ProviderAuthStatus[] = [
  {
    providerId: 'provider-原值',
    name: 'Provider 原始名称',
    configured: true,
    hasApiKey: true,
    hasOAuth: true,
    hasConfigError: false,
    statusText: 'stored'
  }
]

/** Keep hook state mounted across reads while exercising its actual event handlers and IPC calls. */
function harness(overrides: Partial<AuthApi> = {}): {
  read(): ProviderAuthState
  notices: { message: string; severity: 'success' | 'error' }[]
  busy: boolean[]
  calls: { keys: string[][]; oauth: string[]; logout: string[]; prompts: string[][] }
} {
  let cursor = 0
  const slots: { value: unknown }[] = []
  const notices: { message: string; severity: 'success' | 'error' }[] = []
  const busy: boolean[] = []
  const calls = {
    keys: [] as string[][],
    oauth: [] as string[],
    logout: [] as string[],
    prompts: [] as string[][]
  }
  const api: AuthApi = {
    getAuthStatus: async () => statuses,
    loginApiKey: async (id, key) => {
      calls.keys.push([id, key])
      return statuses
    },
    loginOAuth: async (id) => {
      calls.oauth.push(id)
      return statuses
    },
    logout: async (id) => {
      calls.logout.push(id)
    },
    submitAuthInteraction: async (id, value) => {
      calls.prompts.push([id, value])
    },
    ...overrides
  }
  const react = {
    useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void] {
      const index = cursor++
      slots[index] ??= { value: initial }
      const slot = slots[index]
      return [
        slot.value as T,
        (next): void => {
          slot.value =
            typeof next === 'function' ? (next as (previous: unknown) => unknown)(slot.value) : next
        }
      ]
    },
    useCallback: <T>(callback: T): T => callback,
    // Startup scheduling is covered separately; these tests drive explicit auth actions.
    useEffect: (): void => undefined
  }
  const module = { exports: {} as Record<string, unknown> }
  const code = ts.transpileModule(readFileSync('src/renderer/src/useProviderAuth.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  runInNewContext(code, {
    module,
    exports: module.exports,
    window: { api },
    require(specifier: string): unknown {
      if (specifier === 'react') return react
      if (specifier.endsWith('/settingsUi')) return { settingsUi }
      if (specifier.endsWith('/i18n')) return { useUiLanguage: getUiLanguage }
      if (specifier.endsWith('/sessionNotifications')) return { readableErrorMessage }
      throw new Error(`Unexpected runtime import ${specifier}`)
    }
  })
  const hook = module.exports.useProviderAuth as (
    setBusy: (value: boolean) => void,
    notify: (message: string, severity: 'success' | 'error') => void
  ) => ProviderAuthState
  return {
    read: () => {
      cursor = 0
      return hook(
        (value) => busy.push(value),
        (message, severity) => notices.push({ message, severity })
      )
    },
    notices,
    busy,
    calls
  }
}

test('auth actions localize notices without changing provider IDs, keys, or submission values', async () => {
  for (const [language, saved, loggedIn, loggedOut] of [
    [
      'en',
      'API key saved. It will be verified when used.',
      'Authentication succeeded',
      'Provider logged out'
    ],
    ['zh-CN', 'API Key 已保存，使用时验证', 'Auth 登录成功', 'Provider 已登出']
  ] as const) {
    setUiLanguage(language)
    const f = harness()
    const state = f.read()
    await state.submitProviderApiKey('provider-原值', '  key_原始值  ')
    await state.submitProviderOAuth('provider-原值')
    await state.logoutProvider('provider-原值')
    await state.onSubmitAuthPrompt('request-1', '  code 原始值  ')
    assert.deepEqual(
      f.notices.map((notice) => notice.message),
      [saved, loggedIn, loggedOut]
    )
    assert.deepEqual(f.calls.keys, [['provider-原值', '  key_原始值  ']])
    assert.deepEqual(f.calls.oauth, ['provider-原值'])
    assert.deepEqual(f.calls.logout, ['provider-原值'])
    assert.deepEqual(f.calls.prompts, [['request-1', '  code 原始值  ']])
    assert.equal(f.read().providerStatuses, statuses)
    const previousCalls = f.calls.keys.length + f.calls.prompts.length
    await state.submitProviderApiKey('provider-原值', '  ')
    await state.onSubmitAuthPrompt('request-1', '')
    assert.equal(f.calls.keys.length + f.calls.prompts.length, previousCalls)
    assert.equal(f.busy.at(-1), false)
  }
})

test('authorization hints update immediately while URLs, device codes, raw messages and prompt drafts stay intact', () => {
  setUiLanguage('en')
  const f = harness()
  const url = 'https://auth.example.test/authorize?state=AbC%2F123&lang=zh-CN'
  const code = 'ABCD-原值'
  f.read().handleAuthInteractionEvent({
    type: 'notify',
    providerId: 'url',
    event: { type: 'auth_url', url }
  })
  f.read().handleAuthInteractionEvent({
    type: 'notify',
    providerId: 'device',
    event: {
      type: 'device_code',
      userCode: code,
      verificationUri: 'https://auth.example.test/device'
    }
  })
  f.read().handleAuthInteractionEvent({
    type: 'notify',
    providerId: 'raw',
    event: { type: 'progress', message: '服务原文 · Please continue' }
  })
  const prompt = {
    type: 'manual_code' as const,
    message: '服务授权提示原文',
    placeholder: '验证码 / callback URL'
  }
  const promptNeedsSettings = f.read().handleAuthInteractionEvent({
    type: 'prompt',
    providerId: 'url',
    requestId: 'prompt-1',
    prompt
  })
  assert.equal(promptNeedsSettings, true)
  f.read().onUpdatePromptValue('prompt-1', '尚未提交的 code')
  assert.equal(f.read().providerHints.url, `Authorization link: ${url}`)
  assert.equal(f.read().providerHints.device, `Verification code: ${code}`)
  setUiLanguage('zh-CN')
  assert.equal(f.read().providerHints.url, `授权链接：${url}`)
  assert.equal(f.read().providerHints.device, `验证码：${code}`)
  assert.equal(f.read().providerHints.raw, '服务原文 · Please continue')
  assert.equal(f.read().activePrompts[0].prompt, prompt)
  assert.equal(f.read().activePrompts[0].value, '尚未提交的 code')
  assert.equal(f.read().isProviderDialogOpen, true)
  f.read().handleAuthInteractionEvent({
    type: 'prompt',
    providerId: 'url',
    requestId: 'prompt-1',
    prompt: { ...prompt, message: '新的服务原文' }
  })
  assert.equal(f.read().activePrompts.length, 1)
  assert.equal(f.read().activePrompts[0].value, '尚未提交的 code')
  assert.equal(f.calls.oauth.length, 0)
})

test('failed actions localize only the UI prefix and keep service diagnostics unchanged', async () => {
  for (const [language, prefix, fallback] of [
    ['en', 'Unable to save API key: ', 'Authentication failed: Please try again'],
    ['zh-CN', 'API Key 保存失败：', 'Auth 登录失败：请重试']
  ] as const) {
    setUiLanguage(language)
    const f = harness({
      loginApiKey: async () => {
        throw new Error("Error invoking remote method 'auth:login': Error: 服务错误 XYZ")
      },
      loginOAuth: async () => {
        throw null
      }
    })
    await f.read().submitProviderApiKey('provider', 'key')
    await f.read().submitProviderOAuth('provider')
    assert.equal(f.notices[0].message, `${prefix}服务错误 XYZ`)
    assert.equal(f.notices[1].message, fallback)
    assert.ok(f.notices.every((notice) => notice.severity === 'error'))
    assert.equal(f.busy.at(-1), false)
  }
})

test('an in-flight login uses the language selected before the response arrives', async () => {
  let complete!: (value: ProviderAuthStatus[]) => void
  const response = new Promise<ProviderAuthStatus[]>((resolve) => {
    complete = resolve
  })
  setUiLanguage('en')
  const f = harness({ loginApiKey: async () => response })
  const pending = f.read().submitProviderApiKey('provider', 'key')
  setUiLanguage('zh-CN')
  complete(statuses)
  await pending
  assert.equal(f.notices[0].message, 'API Key 已保存，使用时验证')
  assert.equal(f.busy.at(-1), false)
})
