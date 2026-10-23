import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createStartupSplashWindow,
  dismissStartupSplashWindow,
  STARTUP_SPLASH_DRAW_MS,
  STARTUP_SPLASH_FINISH_MS,
  startupSplashHtml,
  type StartupSplashWindow
} from '../src/main/startup-splash'

const ICON_DATA_URL = 'data:image/png;base64,aWNvbg=='

function requiredOptions(value: Record<string, unknown> | null): Record<string, unknown> {
  assert.ok(value)
  return value
}

function invokeScheduled(callback: (() => void) | null): void {
  assert.ok(callback)
  callback()
}

class FakeSplashWindow implements StartupSplashWindow {
  destroyed = false
  shown = 0
  closed = 0
  loadedUrl = ''
  opacities: number[] = []
  events: string[] = []
  scripts: string[] = []
  readyListener: (() => void) | null = null
  failLoad = false
  webContents = {
    executeJavaScript: async (code: string): Promise<void> => {
      this.scripts.push(code)
    }
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  once(_event: 'ready-to-show', listener: () => void): void {
    this.readyListener = listener
  }

  async loadURL(url: string): Promise<void> {
    this.loadedUrl = url
    if (this.failLoad) throw new Error('load failed')
    this.readyListener?.()
  }

  show(): void {
    this.shown += 1
  }

  hide(): void {
    this.events.push('splash.hide')
  }

  close(): void {
    this.events.push('splash.close')
    this.closed += 1
    this.destroyed = true
  }

  setOpacity(opacity: number): void {
    this.opacities.push(opacity)
  }
}

test('startup splash markup embeds only a validated icon and accessible progress copy', () => {
  const markup = startupSplashHtml(ICON_DATA_URL)

  assert.match(markup, /Starting Phi/)
  assert.match(markup, /Preparing the local workspace…/)
  assert.match(startupSplashHtml(ICON_DATA_URL, 'zh-CN'), /正在启动 Phi/)
  assert.match(startupSplashHtml(ICON_DATA_URL, 'zh-CN'), /lang="zh-CN"/)
  assert.match(markup, /lang="en"/)
  assert.match(markup, /role="status"/)
  assert.match(markup, /tracePhi 1\.9s cubic-bezier\([^;]+forwards/)
  assert.match(markup, /watercolorBloom 1\.9s cubic-bezier\([^;]+forwards/)
  assert.doesNotMatch(markup, /tracePhi[^;]+infinite/)
  assert.doesNotMatch(markup, /watercolorBloom[^;]+infinite/)
  assert.match(markup, /globalWatercolorBloom 180ms cubic-bezier/)
  assert.match(markup, /html\.is-finishing \.global-bloom/)
  assert.match(markup, /class="global-bloom"/)
  assert.match(markup, /class="settled-wash"/)
  assert.match(markup, /<feTurbulence/)
  assert.match(markup, /<feDisplacementMap/)
  assert.match(markup, /mask id="pigmentReveal"/)
  assert.match(markup, /class="wash-reveal"/)
  assert.match(markup, /class="wet-trail"/)
  assert.match(markup, /class="phi-stroke"/)
  assert.match(markup, /#00A76F/)
  assert.match(markup, /prefers-color-scheme: dark/)
  assert.match(markup, /prefers-reduced-motion: reduce/)
  assert.match(markup, /backdrop-filter: blur\(24px\)/)
  assert.match(markup, /border-radius: 14px/)
  assert.match(markup, /--surface: rgba\(252, 253, 253, 0\.90\)/)
  assert.match(markup, /--surface: rgba\(13, 18, 24, 0\.92\)/)
  assert.ok(markup.includes(ICON_DATA_URL))
  assert.doesNotMatch(startupSplashHtml('javascript:alert(1)'), /class="icon-fallback"/)
})

test('startup splash paints before startup work continues', async () => {
  const splash = new FakeSplashWindow()
  let options: Record<string, unknown> | null = null

  const result = await createStartupSplashWindow((input) => {
    options = input as Record<string, unknown>
    return splash
  }, ICON_DATA_URL)

  assert.equal(result, splash)
  assert.equal(splash.shown, 1)
  assert.match(decodeURIComponent(splash.loadedUrl), /Starting Phi/)
  const capturedOptions = requiredOptions(options)
  assert.equal(capturedOptions.show, false)
  assert.equal(capturedOptions.alwaysOnTop, true)
  assert.equal(capturedOptions.frame, false)
})

test('startup splash closes cleanly if its local page cannot load', async () => {
  const splash = new FakeSplashWindow()
  splash.failLoad = true

  const result = await createStartupSplashWindow(() => splash, ICON_DATA_URL)

  assert.equal(result, null)
  assert.equal(splash.closed, 1)
})

test('startup splash aligns its one global wash with the end of the single slow draw', async () => {
  const splash = new FakeSplashWindow()
  const mainEvents: string[] = []
  let releaseFinishStart: (() => void) | null = null
  let releaseFinish: (() => void) | null = null
  const delays: number[] = []
  const elapsedBeforeReady = 1_230
  const finishLeadDelay = STARTUP_SPLASH_DRAW_MS - elapsedBeforeReady - STARTUP_SPLASH_FINISH_MS

  await createStartupSplashWindow(
    () => splash,
    ICON_DATA_URL,
    () => 1_000
  )
  dismissStartupSplashWindow(
    splash,
    {
      isDestroyed: () => false,
      show: () => mainEvents.push('show'),
      focus: () => mainEvents.push('focus')
    },
    (callback, delayMs) => {
      delays.push(delayMs)
      if (delayMs === finishLeadDelay) releaseFinishStart = callback
      else if (delayMs === STARTUP_SPLASH_FINISH_MS) releaseFinish = callback
      else callback()
    },
    () => 1_000 + elapsedBeforeReady
  )

  assert.deepEqual(delays, [finishLeadDelay])
  assert.deepEqual(splash.opacities, [])
  assert.deepEqual(mainEvents, [])
  assert.deepEqual(splash.scripts, [])

  invokeScheduled(releaseFinishStart)

  assert.deepEqual(delays, [finishLeadDelay, STARTUP_SPLASH_FINISH_MS])
  assert.deepEqual(splash.scripts, ["document.documentElement.classList.add('is-finishing')"])

  invokeScheduled(releaseFinish)

  assert.deepEqual(splash.opacities, [0.32, 0])
  assert.deepEqual(splash.events, ['splash.hide', 'splash.close'])
  assert.deepEqual(mainEvents, ['show', 'focus'])
})

test('startup splash fades out before focusing the ready main window', () => {
  const splash = new FakeSplashWindow()

  dismissStartupSplashWindow(
    splash,
    {
      isDestroyed: () => false,
      show: () => splash.events.push('main.show'),
      focus: () => splash.events.push('main.focus')
    },
    (callback) => callback()
  )

  assert.deepEqual(splash.opacities, [0.32, 0])
  assert.equal(splash.closed, 1)
  assert.deepEqual(splash.events, ['splash.hide', 'splash.close', 'main.show', 'main.focus'])
})
