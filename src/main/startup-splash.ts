import type { BrowserWindowConstructorOptions } from 'electron'

const FADE_OPACITIES = [0.32, 0] as const
const FADE_STEP_MS = 22
export const STARTUP_SPLASH_DRAW_MS = 1_900
export const STARTUP_SPLASH_FINISH_MS = 190
const PHI_PATH =
  'M172 132 C128 164 116 222 134 270 C151 315 189 329 239 329 C302 329 354 299 376 250 C399 199 377 125 326 116 C279 108 249 142 248 205 L247 320 C247 354 245 382 226 418'
const splashShownAt = new WeakMap<StartupSplashWindow, number>()

export interface StartupSplashWindow {
  isDestroyed: () => boolean
  once: (event: 'ready-to-show', listener: () => void) => unknown
  loadURL: (url: string) => Promise<unknown>
  show: () => void
  hide?: () => void
  close: () => void
  setOpacity?: (opacity: number) => void
  webContents?: {
    executeJavaScript: (code: string) => Promise<unknown>
  }
}

export interface StartupMainWindow {
  isDestroyed: () => boolean
  isVisible?: () => boolean
  show: () => void
  focus?: () => void
}

type StartupSplashFactory = (options: BrowserWindowConstructorOptions) => StartupSplashWindow

type Schedule = (callback: () => void, delayMs: number) => unknown

function safeIconDataUrl(value: string): string {
  return /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(value) ? value : ''
}

export function startupSplashHtml(iconDataUrl: string): string {
  const icon = safeIconDataUrl(iconDataUrl)
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'" />
    <style>
      :root {
        color-scheme: light dark;
        --surface: rgba(252, 253, 253, 0.90);
        --surface-end: rgba(244, 246, 248, 0.86);
        --text: #1C252E;
        --muted: #637381;
        --primary: #00A76F;
        --halo: rgba(0, 167, 111, 0.20);
        --water: #F8FCFA;
        --water-end: #E8F6F1;
        --wash-mint: #C8FAD6;
        --wash-green: #00A76F;
        --wash-cyan: #61F3F3;
        --wash-deep: #007867;
        --border: rgba(145, 158, 171, 0.30);
        --highlight: rgba(255, 255, 255, 0.84);
        --shadow: rgba(28, 37, 46, 0.18);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --surface: rgba(13, 18, 24, 0.92);
          --surface-end: rgba(20, 26, 33, 0.88);
          --text: #FFFFFF;
          --muted: #919EAB;
          --halo: rgba(0, 167, 111, 0.24);
          --water: #10211F;
          --water-end: #0B1717;
          --wash-mint: #7BE7A8;
          --wash-green: #00B878;
          --wash-cyan: #3AD6D6;
          --wash-deep: #006C60;
          --border: rgba(255, 255, 255, 0.13);
          --highlight: rgba(255, 255, 255, 0.11);
          --shadow: rgba(0, 0, 0, 0.42);
        }
      }
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body {
        position: relative;
        display: grid;
        place-items: center;
        color: var(--text);
        background:
          linear-gradient(145deg, var(--highlight), transparent 34%),
          radial-gradient(circle at 50% 38%, var(--halo), transparent 48%),
          linear-gradient(160deg, var(--surface), var(--surface-end));
        border: 1px solid var(--border);
        border-radius: 14px;
        box-shadow:
          inset 0 1px 0 var(--highlight),
          inset 0 -1px 0 rgba(0, 0, 0, 0.06),
          0 24px 64px var(--shadow);
        backdrop-filter: blur(24px) saturate(1.18);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        user-select: none;
        -webkit-app-region: drag;
      }
      body::before {
        content: "";
        position: absolute;
        inset: -24%;
        z-index: -1;
        background:
          radial-gradient(circle at 30% 22%, rgba(200, 250, 214, 0.38), transparent 30%),
          radial-gradient(circle at 72% 24%, rgba(97, 243, 243, 0.16), transparent 28%),
          radial-gradient(circle at 55% 82%, var(--halo), transparent 36%);
        filter: blur(28px);
      }
      main { display: flex; flex-direction: column; align-items: center; gap: 16px; text-align: center; }
      .icon {
        width: 112px;
        height: 112px;
        display: grid;
        place-items: center;
        filter: drop-shadow(0 18px 24px rgba(0, 75, 80, 0.26));
      }
      .water-icon, .icon-fallback { width: 112px; height: 112px; display: block; }
      .icon-fallback { display: none; }
      .water-surface {
        transform-origin: center;
        animation: waterBreath 4.6s ease-in-out infinite alternate;
      }
      .wash-reveal, .wet-trail, .phi-stroke {
        fill: none;
        stroke-dasharray: 1;
        stroke-dashoffset: 1;
        stroke-linecap: round;
        stroke-linejoin: round;
        animation: tracePhi 1.9s cubic-bezier(0.22, 0.78, 0.24, 1) forwards;
      }
      .wash-reveal { stroke: #FFFFFF; stroke-width: 188; }
      .wet-trail { stroke: url(#splashInk); stroke-width: 116; opacity: 0.68; }
      .phi-stroke { stroke: #FFFFFF; stroke-width: 42; }
      .bloom {
        opacity: 0;
        transform-box: fill-box;
        transform-origin: center;
        animation: watercolorBloom 1.9s cubic-bezier(0.12, 0.72, 0.18, 1) var(--delay) forwards;
      }
      .global-bloom {
        opacity: 0;
        transform-box: fill-box;
        transform-origin: center;
      }
      .settled-wash {
        opacity: 0;
      }
      html.is-finishing .global-bloom {
        animation: globalWatercolorBloom 180ms cubic-bezier(0.12, 0.72, 0.18, 1) forwards;
      }
      html.is-finishing .settled-wash {
        animation: settleWash 150ms ease-out 30ms forwards;
      }
      h1, p { margin: 0; }
      h1 { font-size: 16px; font-weight: 650; letter-spacing: 0.01em; }
      p { color: var(--muted); font-size: 13px; }
      .dots { height: 8px; display: flex; align-items: center; gap: 5px; }
      .dots span {
        width: 4px;
        height: 4px;
        border-radius: 999px;
        background: var(--primary);
        animation: dot 1.2s ease-in-out infinite;
      }
      .dots span:nth-child(2) { animation-delay: 120ms; }
      .dots span:nth-child(3) { animation-delay: 240ms; }
      @keyframes tracePhi {
        0% { opacity: 0.24; stroke-dashoffset: 1; }
        100% { opacity: 1; stroke-dashoffset: 0; }
      }
      @keyframes watercolorBloom {
        0%, 12% { opacity: 0; transform: scale(0.14); }
        56% { opacity: 0.84; transform: scale(0.96); }
        100% { opacity: 0.52; transform: scale(1.3); }
      }
      @keyframes globalWatercolorBloom {
        0% { opacity: 0; transform: scale(0.08); }
        34% { opacity: 0.48; transform: scale(0.54); }
        72% { opacity: 0.78; transform: scale(1.12); }
        100% { opacity: 0.74; transform: scale(1.52); }
      }
      @keyframes settleWash {
        from { opacity: 0; }
        to { opacity: 0.32; }
      }
      @keyframes waterBreath {
        from { transform: scale(1.01) translate3d(-1px, 1px, 0); }
        to { transform: scale(1.045) translate3d(2px, -2px, 0); }
      }
      @keyframes dot {
        0%, 60%, 100% { opacity: 0.32; transform: translateY(0); }
        30% { opacity: 1; transform: translateY(-3px); }
      }
      @media (prefers-reduced-motion: reduce) {
        .water-surface, .wash-reveal, .wet-trail, .phi-stroke, .bloom, .global-bloom, .settled-wash, .dots span { animation: none; }
        .wash-reveal, .wet-trail, .phi-stroke { stroke-dashoffset: 0; }
        .bloom { opacity: 0.64; transform: scale(1.28); }
        .global-bloom { opacity: 0.74; transform: scale(1.52); }
        .settled-wash { opacity: 0.32; }
        .icon.has-fallback .water-icon { display: none; }
        .icon.has-fallback .icon-fallback { display: block; }
        .dots span { opacity: 0.7; }
      }
    </style>
  </head>
  <body>
    <main role="status" aria-live="polite" aria-label="Phi 正在启动，正在准备本地工作台">
      <div class="icon${icon ? ' has-fallback' : ''}" aria-hidden="true">
        <svg class="water-icon" viewBox="0 0 512 512" focusable="false">
          <defs>
            <linearGradient id="splashWater" x1="86" y1="62" x2="420" y2="456" gradientUnits="userSpaceOnUse">
              <stop offset="0" style="stop-color:var(--water)" />
              <stop offset="1" style="stop-color:var(--water-end)" />
            </linearGradient>
            <linearGradient id="splashInk" x1="116" y1="112" x2="386" y2="390" gradientUnits="userSpaceOnUse">
              <stop offset="0" style="stop-color:var(--wash-mint)" />
              <stop offset="0.46" style="stop-color:var(--wash-cyan)" />
              <stop offset="0.72" style="stop-color:var(--wash-green)" />
              <stop offset="1" style="stop-color:var(--wash-deep)" />
            </linearGradient>
            <clipPath id="splashShape"><rect width="512" height="512" rx="114" /></clipPath>
            <filter id="splashShadow" x="-24%" y="-24%" width="148%" height="160%">
              <feDropShadow dx="0" dy="16" stdDeviation="15" flood-color="#004B50" flood-opacity="0.28" />
            </filter>
            <filter id="watercolorPigment" x="-45%" y="-45%" width="190%" height="190%" color-interpolation-filters="sRGB">
              <feGaussianBlur stdDeviation="18" result="softPigment" />
              <feTurbulence type="fractalNoise" baseFrequency="0.012 0.026" numOctaves="3" seed="17" result="flow" />
              <feDisplacementMap in="softPigment" in2="flow" scale="34" xChannelSelector="R" yChannelSelector="B" />
            </filter>
            <filter id="wetPaper" x="-12%" y="-12%" width="124%" height="124%">
              <feTurbulence type="fractalNoise" baseFrequency="0.022 0.032" numOctaves="2" seed="9" result="paperGrain" />
              <feColorMatrix in="paperGrain" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.08 0" result="softGrain" />
              <feBlend in="SourceGraphic" in2="softGrain" mode="soft-light" />
            </filter>
            <filter id="revealBlur" x="-45%" y="-45%" width="190%" height="190%">
              <feGaussianBlur stdDeviation="24" />
            </filter>
            <mask id="pigmentReveal" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
              <rect width="512" height="512" fill="#000000" />
              <path class="wash-reveal" pathLength="1" d="${PHI_PATH}" filter="url(#revealBlur)" />
            </mask>
          </defs>
          <g transform="translate(46 46) scale(0.82)" filter="url(#splashShadow)">
            <rect width="512" height="512" rx="114" fill="var(--wash-deep)" />
            <g clip-path="url(#splashShape)" filter="url(#wetPaper)">
              <g class="water-surface">
                <rect width="512" height="512" fill="url(#splashWater)" />
                <ellipse cx="116" cy="94" rx="210" ry="176" fill="var(--highlight)" opacity="0.34" />
              </g>
              <circle class="global-bloom" cx="256" cy="258" r="252" fill="url(#splashInk)" filter="url(#watercolorPigment)" />
              <rect class="settled-wash" width="512" height="512" fill="url(#splashInk)" />
              <g mask="url(#pigmentReveal)">
                <rect width="512" height="512" fill="url(#splashInk)" opacity="0.52" />
                <g filter="url(#watercolorPigment)">
                  <circle class="bloom" style="--delay:80ms" cx="154" cy="176" r="116" fill="var(--wash-mint)" />
                  <circle class="bloom" style="--delay:180ms" cx="158" cy="292" r="124" fill="var(--wash-green)" />
                  <circle class="bloom" style="--delay:280ms" cx="296" cy="326" r="138" fill="var(--wash-cyan)" />
                  <circle class="bloom" style="--delay:380ms" cx="374" cy="206" r="132" fill="var(--wash-deep)" />
                  <circle class="bloom" style="--delay:480ms" cx="270" cy="154" r="112" fill="var(--wash-mint)" />
                  <circle class="bloom" style="--delay:600ms" cx="244" cy="388" r="118" fill="var(--wash-green)" />
                </g>
              </g>
              <path class="wet-trail" pathLength="1" d="${PHI_PATH}" filter="url(#watercolorPigment)" />
              <path class="phi-stroke" pathLength="1" d="${PHI_PATH}" />
            </g>
          </g>
        </svg>
        ${icon ? `<img class="icon-fallback" src="${icon}" alt="" />` : ''}
      </div>
      <h1>正在启动 Phi</h1>
      <p>正在准备本地工作台…</p>
      <div class="dots" aria-hidden="true"><span></span><span></span><span></span></div>
    </main>
  </body>
</html>`
}

export async function createStartupSplashWindow(
  createWindow: StartupSplashFactory,
  iconDataUrl: string,
  now: () => number = Date.now
): Promise<StartupSplashWindow | null> {
  const window = createWindow({
    width: 360,
    height: 300,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    center: true,
    backgroundColor: '#00000000',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false
    }
  })
  let shown = false
  const show = (): void => {
    if (shown || window.isDestroyed()) return
    shown = true
    splashShownAt.set(window, now())
    window.show()
  }
  window.once('ready-to-show', show)

  try {
    const html = startupSplashHtml(iconDataUrl)
    await window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
    show()
    return window
  } catch {
    if (!window.isDestroyed()) window.close()
    return null
  }
}

export function dismissStartupSplashWindow(
  splash: StartupSplashWindow | null,
  mainWindow: StartupMainWindow,
  schedule: Schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  now: () => number = Date.now
): void {
  const revealMain = (): void => {
    if (mainWindow.isDestroyed()) return
    if (mainWindow.isVisible?.() !== true) mainWindow.show()
    mainWindow.focus?.()
  }
  if (!splash || splash.isDestroyed()) {
    revealMain()
    return
  }

  const fadeAndReveal = (): void => {
    const closeSplash = (): void => {
      try {
        splash.hide?.()
      } catch {
        // Closing still removes a splash that cannot be hidden explicitly.
      }
      splash.close()
      revealMain()
    }
    let index = 0
    const step = (): void => {
      if (splash.isDestroyed()) {
        revealMain()
        return
      }
      const opacity = FADE_OPACITIES[index]
      if (opacity === undefined) {
        closeSplash()
        return
      }
      try {
        splash.setOpacity?.(opacity)
      } catch {
        closeSplash()
        return
      }
      index += 1
      schedule(step, FADE_STEP_MS)
    }
    step()
  }

  const beginFinish = (): void => {
    try {
      const finishAnimation = splash.webContents?.executeJavaScript(
        "document.documentElement.classList.add('is-finishing')"
      )
      void finishAnimation?.catch(() => undefined)
    } catch {
      // The timed fallback still closes the splash if its renderer is unavailable.
    }
    schedule(fadeAndReveal, STARTUP_SPLASH_FINISH_MS)
  }

  const shownAt = splashShownAt.get(splash)
  const remainingDrawMs =
    shownAt === undefined ? 0 : Math.max(0, STARTUP_SPLASH_DRAW_MS - (now() - shownAt))
  const finishLeadDelayMs = Math.max(0, remainingDrawMs - STARTUP_SPLASH_FINISH_MS)
  if (finishLeadDelayMs > 0) schedule(beginFinish, finishLeadDelayMs)
  else beginFinish()
}
