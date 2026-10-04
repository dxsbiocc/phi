import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement, type ComponentProps, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import type { BrowserRendererBridge, BrowserTabSnapshot } from '../src/shared/browserTypes'
import BrowserPanel, { BrowserStatusPane } from '../src/renderer/src/features/browser/BrowserPanel'
import { BrowserTabs } from '../src/renderer/src/features/browser/components/BrowserTabs'
import { BrowserToolbar } from '../src/renderer/src/features/browser/components/BrowserToolbar'

const tab = (overrides: Partial<BrowserTabSnapshot> = {}): BrowserTabSnapshot => ({
  id: 'tab-1',
  title: 'Example',
  url: 'https://example.test/',
  origin: 'https://example.test',
  phase: 'ready',
  canGoBack: true,
  canGoForward: false,
  isAgentControlled: false,
  documentRevision: 2,
  ...overrides
})

function renderWithTheme(element: ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

test('browser toolbar exposes compact keyboard-accessible loading controls', () => {
  const markup = renderWithTheme(
    createElement(BrowserToolbar, {
      address: 'https://example.test/',
      activeTab: tab({ phase: 'loading', canGoForward: true }),
      busy: true,
      disabled: false,
      onAddressChange: () => undefined,
      onAddressFocus: () => undefined,
      onAddressBlur: () => undefined,
      onRestoreAddress: () => undefined,
      onSubmit: () => undefined,
      onBack: () => undefined,
      onForward: () => undefined,
      onReloadOrStop: () => undefined,
      onOpenExternal: () => undefined
    } satisfies ComponentProps<typeof BrowserToolbar>)
  )

  assert.match(markup, /data-phi-browser-toolbar="true"/)
  assert.match(markup, /aria-label="后退"/)
  assert.match(markup, /aria-label="前进"/)
  assert.match(markup, /aria-label="停止加载"/)
  const stopButton = markup.match(/<button[^>]*aria-label="停止加载"[^>]*>/)?.[0] ?? ''
  assert.doesNotMatch(stopButton, /disabled/)
  assert.match(markup, /aria-pressed="true"/)
  assert.match(markup, /aria-label="网址"/)
  assert.match(markup, /inputMode="url"|inputmode="url"/)
  assert.match(markup, /autoCapitalize="none"|autocapitalize="none"/)
  assert.match(markup, /value="https:\/\/example\.test\/"/)
  assert.match(markup, /role="progressbar"/)
  assert.match(markup, /height:66px/)
  assert.match(markup, /width:44px/)
  assert.match(markup, /height:44px/)
  assert.match(markup, /height:48px/)
  assert.match(markup, /gap:8px/)
  assert.match(markup, /data-phi-browser-progress-slot="true"/)
  assert.match(markup, /height:2px/)
  assert.match(markup, /min-width:0/)
  assert.match(markup, /overflow:hidden/)
  assert.match(markup, /aria-label="在默认浏览器中打开"/)
  const externalButton =
    markup.match(/<button[^>]*aria-label="在默认浏览器中打开"[^>]*>/)?.[0] ?? ''
  assert.match(externalButton, /disabled/)
})

test('browser toolbar disables explicit system open for blank restorable and failed pages', () => {
  for (const activeTab of [
    tab({ url: 'about:blank' }),
    tab({ restorable: true }),
    tab({ phase: 'failed' })
  ]) {
    const markup = renderWithTheme(
      createElement(BrowserToolbar, {
        address: activeTab.url,
        activeTab,
        busy: false,
        disabled: false,
        onAddressChange: () => undefined,
        onAddressFocus: () => undefined,
        onAddressBlur: () => undefined,
        onRestoreAddress: () => undefined,
        onSubmit: () => undefined,
        onBack: () => undefined,
        onForward: () => undefined,
        onReloadOrStop: () => undefined,
        onOpenExternal: () => undefined
      } satisfies ComponentProps<typeof BrowserToolbar>)
    )
    const externalButton =
      markup.match(/<button[^>]*aria-label="在默认浏览器中打开"[^>]*>/)?.[0] ?? ''
    assert.match(externalButton, /disabled/)
  }
})

test('browser tabs expose compact accessible multi-page controls without close propagation', () => {
  const markup = renderWithTheme(
    createElement(BrowserTabs, {
      tabs: [
        tab({ id: 'tab-1', title: 'Documentation' }),
        tab({
          id: 'tab-2',
          title: '',
          url: 'https://docs.example.test/reference',
          phase: 'loading'
        }),
        tab({ id: 'tab-3', title: '', url: 'about:blank' })
      ],
      activeTabId: 'tab-1',
      disabled: false,
      globalControlsInset: 136,
      onNewTab: () => undefined,
      onActivate: () => undefined,
      onClose: () => undefined
    } satisfies ComponentProps<typeof BrowserTabs>)
  )

  assert.match(markup, /data-phi-browser-tabs="true"/)
  assert.match(markup, /role="tablist"/)
  assert.match(markup, /aria-label="浏览器标签页"/)
  assert.match(markup, /data-phi-browser-tab="active"/)
  assert.match(markup, /aria-selected="true"/)
  assert.match(markup, /data-phi-browser-tab="inactive"/)
  assert.match(markup, /aria-selected="false"/)
  assert.match(markup, />Documentation</)
  assert.match(markup, />docs\.example\.test</)
  assert.match(markup, />新标签页</)
  assert.match(markup, /aria-label="正在加载 docs\.example\.test"/)
  assert.match(markup, /role="progressbar"/)
  assert.match(markup, /aria-label="关闭 Documentation"/)
  assert.match(markup, /aria-label="新建标签页"/)
  assert.match(markup, /overflow-x:auto/)
  assert.match(markup, /height:50px/)
  assert.match(markup, /min-height:44px/)
  assert.match(markup, /width:40px/)
  assert.match(markup, /width:44px/)
  assert.match(markup, /data-phi-browser-window-controls-reserve="true"/)
  assert.match(markup, /width:136px/)

  const tabsSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/browser/components/BrowserTabs.tsx'),
    'utf8'
  )
  assert.match(tabsSource, /onKeyDown=\{\(event\) => \{[\s\S]{0,180}isBrowserTabActivationKey/)
  assert.match(
    tabsSource,
    /aria-label=\{`关闭[\s\S]{0,400}onClick=\{\(event\) => \{[\s\S]{0,120}event\.stopPropagation\(\)/
  )
  assert.match(
    tabsSource,
    /aria-label=\{`关闭[\s\S]{0,600}onKeyDown=\{\(event\) => \{[\s\S]{0,160}event\.stopPropagation\(\)/
  )
  assert.match(tabsSource, /WebkitAppRegion: 'drag'/)
  assert.match(tabsSource, /WebkitAppRegion: 'no-drag'/)
  assert.match(tabsSource, /tabIndex=\{selected \|\| fallbackTabStop \? 0 : -1\}/)
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    assert.match(tabsSource, new RegExp(`'${key}'`))
  }
  assert.doesNotMatch(tabsSource, /WorkspaceTab/)
  assert.doesNotMatch(tabsSource, /borderColor: selected/)

  const panelSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/browser/BrowserPanel.tsx'),
    'utf8'
  )
  assert.match(panelSource, /id="phi-browser-viewport"/)
  assert.match(panelSource, /role="tabpanel"/)
})

test('browser panel and status panes render friendly empty restore and failure states', () => {
  const bridge: BrowserRendererBridge = {
    execute: async (): Promise<never> => {
      throw new Error('not called during server render')
    },
    snapshot: async (): Promise<never> => {
      throw new Error('not called during server render')
    },
    setViewport: async () => undefined,
    onEvent: () => () => undefined
  }
  const emptyPanel = renderWithTheme(
    createElement(BrowserPanel, {
      bridge,
      activePhiSessionId: null,
      activeSessionGeneration: 0,
      visible: true
    })
  )
  assert.match(emptyPanel, /data-phi-browser-panel="true"/)
  assert.match(emptyPanel, /选择一个会话后即可浏览网页/)
  assert.match(emptyPanel, /aria-label="网址"[^>]*disabled/)

  const noTab = renderWithTheme(
    createElement(BrowserStatusPane, {
      activePhiSessionId: 'phi-session',
      loading: false,
      error: null,
      busy: false,
      activeTab: null,
      nativeEnabled: false,
      onRestore: () => undefined,
      onRetry: () => undefined
    })
  )
  assert.match(noTab, /输入网址开始浏览/)
  assert.match(noTab, /HTTPS 或 localhost/)

  const loading = renderWithTheme(
    createElement(BrowserStatusPane, {
      activePhiSessionId: 'phi-session',
      loading: true,
      error: null,
      busy: false,
      activeTab: null,
      nativeEnabled: false,
      onRestore: () => undefined,
      onRetry: () => undefined
    })
  )
  assert.match(loading, /正在准备浏览器/)
  assert.match(loading, /role="status"/)

  const restorable = renderWithTheme(
    createElement(BrowserStatusPane, {
      activePhiSessionId: 'phi-session',
      loading: false,
      error: null,
      busy: false,
      activeTab: tab({ restorable: true }),
      nativeEnabled: false,
      onRestore: () => undefined,
      onRetry: () => undefined
    })
  )
  assert.match(restorable, /恢复页面/)
  assert.match(restorable, /role="status"/)

  const failed = renderWithTheme(
    createElement(BrowserStatusPane, {
      activePhiSessionId: 'phi-session',
      loading: false,
      error: null,
      busy: true,
      activeTab: tab({ phase: 'failed' }),
      nativeEnabled: false,
      onRestore: () => undefined,
      onRetry: () => undefined
    })
  )
  assert.match(failed, /页面加载失败/)
  assert.match(failed, /重试/)
  assert.match(failed, /role="alert"/)
  const retryButton = failed.match(/<button[^>]*>重试<\/button>/)?.[0] ?? ''
  assert.match(retryButton, /disabled/)

  const crashed = renderWithTheme(
    createElement(BrowserStatusPane, {
      activePhiSessionId: 'phi-session',
      loading: false,
      error: null,
      busy: false,
      activeTab: tab({ phase: 'crashed' }),
      nativeEnabled: false,
      onRestore: () => undefined,
      onRetry: () => undefined
    })
  )
  assert.match(crashed, /页面停止响应/)
  assert.match(crashed, /role="alert"/)
  const crashedRetry = crashed.match(/<button[^>]*>重试<\/button>/)?.[0] ?? ''
  assert.doesNotMatch(crashedRetry, /disabled/)
})

test('App composes the browser feature through the narrow side-panel seam', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  assert.match(appSource, /import BrowserPanel from '\.\/features\/browser\/BrowserPanel'/)
  assert.match(
    appSource,
    /if \(mode === 'browser'\)[\s\S]{0,500}<BrowserPanel[\s\S]{0,300}bridge=\{rendererApi\.browser\}/
  )
  assert.match(appSource, /activePhiSessionId=\{activePhiSessionId \?\? null\}/)
  assert.match(appSource, /activeSessionGeneration=\{activeSessionGeneration\}/)
  assert.match(
    appSource,
    /visible=\{[\s\S]{0,300}!pendingApproval[\s\S]{0,300}!pendingUserInteraction/
  )
  assert.match(appSource, /!isWorkspaceSidebarPreviewOpen/)
  assert.match(appSource, /features\/browser\/hooks\/useBrowserTrustedOverlayGate/)
  assert.match(appSource, /features\/browser\/hooks\/useBrowserPanelRequests/)
  assert.match(
    appSource,
    /openBrowserPanelFromRequest = useCallback\([\s\S]{0,160}openWorkspaceSidePanel\('browser'\)/
  )
  assert.match(appSource, /headerActions=\{slotContext\.headerActions\}/)
  assert.match(appSource, /globalControlsInset=\{slotContext\.globalControlsInset\}/)
  assert.match(
    appSource,
    /useBrowserPanelRequests\(\{[\s\S]{0,160}activeSessionId: activePhiSessionId[\s\S]{0,160}onRequest: openBrowserPanelFromRequest/
  )
  assert.match(
    appSource,
    /useBrowserPanelRequests\(\{[\s\S]{0,260}onFailure: showBrowserAppShellFailure/
  )
  assert.match(appSource, /!browserOverlaySuspended/)
  assert.match(
    appSource,
    /onAuthInteraction\(\(event\) => \{[\s\S]{0,180}enqueueBrowserTrustedOverlay/
  )
  assert.match(
    appSource,
    /onToolApprovalRequest\(\(event\) => \{[\s\S]{0,120}enqueueBrowserTrustedOverlay/
  )
  assert.match(
    appSource,
    /onAgentUserInteractionRequest\(\(event\) => \{[\s\S]{0,120}enqueueBrowserTrustedOverlay/
  )
  assert.match(appSource, /setIsSettingsOpen=\{setSettingsOpenWithBrowserGate\}/)
  assert.match(
    appSource,
    /onOpenSessionSearch=\{\(\) => setSessionSearchOpenWithBrowserGate\(true\)\}/
  )
  assert.match(appSource, /openLocalTrustedOverlay\('session-export'/)
  assert.doesNotMatch(appSource, /onOpenExternal=\{[^}]+\}/)

  const trustedGateHook = readFileSync(
    resolve(
      process.cwd(),
      'src/renderer/src/features/browser/hooks/useBrowserTrustedOverlayGate.ts'
    ),
    'utf8'
  )
  assert.match(trustedGateHook, /class BrowserViewportHider/)
  assert.match(
    trustedGateHook,
    /viewportHider\.update\([\s\S]{0,180}options\.activeSessionGeneration/
  )
  assert.match(trustedGateHook, /\[closeBrowserPanel, onFailure, viewportHider\]/)
})

test('browser approvals are scoped and presented as one-action decisions in both approval surfaces', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const dialogSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/ToolApprovalDialog.tsx'),
    'utf8'
  )
  const permissionSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/PermissionView.tsx'),
    'utf8'
  )
  assert.match(
    appSource,
    /onToolApprovalCancelled\(\(requestId\)[\s\S]{0,260}request\.requestId === requestId/
  )
  assert.match(appSource, /cancelBrowserTrustedOverlay\('approval', requestId\)/)
  for (const source of [dialogSource, permissionSource]) {
    assert.match(source, /browser: '浏览器操作'/)
    assert.match(source, /仅允许这一次/)
  }
})

test('browser viewport hook keeps the native rectangle below toolbar and cleans every observer', () => {
  const panelSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/browser/BrowserPanel.tsx'),
    'utf8'
  )
  const viewportSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/browser/hooks/useBrowserViewport.ts'),
    'utf8'
  )
  assert.ok(
    panelSource.indexOf('<BrowserToolbar') < panelSource.indexOf('data-phi-browser-native-viewport')
  )
  assert.match(panelSource, /capabilities\.presentation === 'native'/)
  assert.match(viewportSource, /new ResizeObserver\(updateForTrustedOverlay\)/)
  assert.match(viewportSource, /window\.requestAnimationFrame\(callback\)/)
  assert.match(viewportSource, /window\.cancelAnimationFrame\(id\)/)
  assert.match(viewportSource, /window\.addEventListener\('resize', onWindowResize\)/)
  assert.match(viewportSource, /window\.removeEventListener\('resize', onWindowResize\)/)
  assert.match(viewportSource, /observer\?\.disconnect\(\)/)
  assert.match(viewportSource, /new MutationObserver/)
  assert.match(viewportSource, /MuiModal-root|MuiPopover-root/)
  assert.match(viewportSource, /role="dialog"|role=\\"dialog\\"/)
  assert.match(viewportSource, /scheduler\.dispose\(\)/)
  assert.match(viewportSource, /viewport: null/)
})
