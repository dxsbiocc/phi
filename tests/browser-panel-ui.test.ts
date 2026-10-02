import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement, type ComponentProps, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import type { BrowserRendererBridge, BrowserTabSnapshot } from '../src/shared/browserTypes'
import BrowserPanel, { BrowserStatusPane } from '../src/renderer/src/features/browser/BrowserPanel'
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
      onReloadOrStop: () => undefined
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
  assert.match(markup, /height:48px/)
  assert.match(markup, /height:36px/)
  assert.match(markup, /data-phi-browser-progress-slot="true"/)
  assert.match(markup, /height:2px/)
  assert.match(markup, /min-width:0/)
  assert.match(markup, /overflow:hidden/)
  assert.doesNotMatch(markup, /在系统浏览器中打开|openExternal/)
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
})

test('App composes the browser feature through the narrow side-panel seam', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  assert.match(appSource, /import BrowserPanel from '\.\/features\/browser\/BrowserPanel'/)
  assert.match(
    appSource,
    /workspaceSidePanelMode === 'browser'[\s\S]{0,500}<BrowserPanel[\s\S]{0,300}bridge=\{rendererApi\.browser\}/
  )
  assert.match(appSource, /activePhiSessionId=\{activePhiSessionId \?\? null\}/)
  assert.match(
    appSource,
    /visible=\{[\s\S]{0,300}!pendingApproval[\s\S]{0,300}!pendingUserInteraction/
  )
  assert.match(appSource, /!isWorkspaceSidebarPreviewOpen/)
  assert.match(appSource, /features\/browser\/hooks\/useBrowserTrustedOverlayGate/)
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
