import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { getUiLanguage, setUiLanguage } from '../src/renderer/src/lib/i18n'
import { AppearanceSettingsSection } from '../src/renderer/src/features/settings/components/AppearanceSettingsSection'
import { BrowserStatusPane } from '../src/renderer/src/features/browser/BrowserPanel'
import {
  browserErrorMessage,
  browserTabDisplayTitle
} from '../src/renderer/src/features/browser/lib/browserPanelState'
import { TerminalStatusPane } from '../src/renderer/src/features/terminal/components/TerminalStatusPane'
import {
  terminalDraftErrorMessage,
  substituteTerminalDraftInputs
} from '../src/renderer/src/features/terminal/lib/terminalDraft'
import {
  managedEnvironmentStateLabel,
  managedEnvironmentSourceLabel
} from '../src/renderer/src/features/environment/lib/environmentPanel'
import {
  formatBuildEstimate,
  formatEnvironmentSize
} from '../src/renderer/src/lib/environmentFormatting'
import { providerStatusText } from '../src/renderer/src/features/settings/lib/providerStatusText'
import { settingsUi } from '../src/renderer/src/features/settings/lib/settingsUi'

const theme = createTheme()
const render = (element: React.ReactElement): string =>
  renderToStaticMarkup(createElement(ThemeProvider, { theme }, element))
afterEach(() => setUiLanguage('en'))

test('settings start in English and expose both language autonyms with saving disabled', () => {
  assert.equal(getUiLanguage(), 'en')
  const markup = render(
    createElement(AppearanceSettingsSection, {
      mode: 'system',
      palette: 'minimal',
      onSelectMode: () => undefined,
      onSelectPalette: () => undefined,
      onSelectLanguage: () => undefined,
      savingLanguage: true
    })
  )
  assert.match(markup, /Interface language/)
  assert.match(markup, /English/)
  assert.match(markup, /简体中文/)
  const languageRadios = markup.match(/<input[^>]*name="interface-language"[^>]*>/g) ?? []
  assert.equal(languageRadios.length, 2)
  assert.ok(languageRadios.every((radio) => radio.includes('disabled=""')))
  assert.ok(languageRadios.find((radio) => radio.includes('checked=""'))?.includes('value="en"'))
})

test('appearance labels and saved formatter functions resolve the current language', () => {
  const enabledCount = settingsUi.valueValueEnabled
  for (const [language, appearance, light, selected] of [
    ['en', 'Appearance', 'Light', '2/3 enabled'],
    ['zh-CN', '外观', '浅色', '2/3 已启用']
  ] as const) {
    setUiLanguage(language)
    const markup = render(
      createElement(AppearanceSettingsSection, {
        mode: 'light',
        palette: 'asana',
        onSelectMode: () => undefined,
        onSelectPalette: () => undefined
      })
    )
    assert.ok(markup.includes(appearance))
    assert.ok(markup.includes(light))
    assert.equal(enabledCount(2, 3), selected)
    const radios = markup.match(/<input[^>]*name="interface-language"[^>]*>/g) ?? []
    assert.ok(radios.find((radio) => radio.includes('checked=""'))?.includes(`value="${language}"`))
  }
})

test('environment labels switch after module import and explicit formatting languages remain independent', () => {
  setUiLanguage('en')
  assert.equal(managedEnvironmentStateLabel('ready'), 'Ready')
  assert.equal(managedEnvironmentSourceLabel('project'), 'Current project')
  assert.equal(formatEnvironmentSize(undefined), 'Unknown')
  assert.equal(formatEnvironmentSize(undefined, 'zh-CN'), '未知')
  assert.equal(formatBuildEstimate(undefined), 'Download size unavailable')
  setUiLanguage('zh-CN')
  assert.equal(managedEnvironmentStateLabel('ready'), '已就绪')
  assert.equal(managedEnvironmentSourceLabel('project'), '当前项目')
  assert.equal(formatEnvironmentSize(undefined), '未知')
  assert.equal(formatEnvironmentSize(undefined, 'en'), 'Unknown')
  assert.equal(formatBuildEstimate(undefined, 'en'), 'Download size unavailable')
})

test('browser and terminal statuses translate without modifying page titles or command input', () => {
  const userTitle = '用户文档 · My page'
  const page = { title: userTitle, url: 'https://example.test/' } as Parameters<
    typeof browserTabDisplayTitle
  >[0]
  for (const [language, browserTitle, terminalTitle] of [
    ['en', 'Enter an address to start browsing', 'Starting shell…'],
    ['zh-CN', '输入网址开始浏览', '正在启动 Shell…']
  ] as const) {
    setUiLanguage(language)
    const browser = render(
      createElement(BrowserStatusPane, {
        activePhiSessionId: 'session',
        loading: false,
        busy: false,
        error: null,
        activeTab: null,
        nativeEnabled: false,
        onRestore: () => undefined,
        onRetry: () => undefined
      })
    )
    assert.ok(browser.includes(browserTitle))
    assert.ok(
      render(createElement(TerminalStatusPane, { kind: 'starting' })).includes(terminalTitle)
    )
    assert.equal(browserTabDisplayTitle(page), userTitle)
    assert.equal(
      substituteTerminalDraftInputs(
        'printf "%s" "<path>"',
        [{ name: 'path', description: '目录' }],
        { path: '原始目录' }
      ),
      'printf "%s" "原始目录"'
    )
  }
  setUiLanguage('en')
  assert.equal(
    browserErrorMessage({ code: 'NAVIGATION_FAILED' }),
    'Page failed to load. Please try again.'
  )
  assert.equal(terminalDraftErrorMessage('请先配置模型'), 'Configure a model in settings first')
})

test('provider source status values translate but external diagnostic text is preserved', () => {
  setUiLanguage('en')
  assert.equal(providerStatusText('未配置'), 'Not configured')
  assert.equal(providerStatusText('stored'), 'Saved credentials')
  assert.equal(providerStatusText('external custom 说明'), 'external custom 说明')
  setUiLanguage('zh-CN')
  assert.equal(providerStatusText('stored'), '已保存的凭据')
  assert.equal(providerStatusText('external custom 说明'), 'external custom 说明')
})
