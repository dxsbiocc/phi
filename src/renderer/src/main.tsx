import './assets/main.css'
import '@fontsource-variable/dm-sans'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { observeWindowFirstFrame } from './lib/windowStartup'

// Auto-hide scrollbars: scrolling reveals the capsule thumb (see base.css);
// 0.5s after scrolling stops it fades out over 250ms (the theme's standard
// transition duration). Scrollbar pseudo-elements don't support CSS
// transitions, so the fade is driven from here as a few instant alpha steps
// via --phi-thumb-alpha. Hovering or dragging the thumb keeps it visible so
// it stays grabbable.
const SCROLLBAR_HIDE_DELAY_MS = 500
const SCROLLBAR_FADE_MS = 250
const SCROLLBAR_THUMB_ALPHA = 0.45
const SCROLLBAR_FADE_STEPS = 5

function initScrollbarAutoHide(): void {
  const timers = new WeakMap<Element, number[]>()

  const setThumbAlpha = (el: Element, alpha: number): void => {
    ;(el as HTMLElement).style.setProperty('--phi-thumb-alpha', alpha.toFixed(3))
  }

  const schedule = (el: Element, fn: () => void, delay: number): void => {
    timers.get(el)?.push(window.setTimeout(fn, delay))
  }

  const fadeOut = (el: Element): void => {
    for (let i = 1; i <= SCROLLBAR_FADE_STEPS; i += 1) {
      schedule(
        el,
        () => {
          if (!el.isConnected) return
          if (i === SCROLLBAR_FADE_STEPS) {
            ;(el as HTMLElement).style.removeProperty('--phi-thumb-alpha')
          } else {
            setThumbAlpha(el, SCROLLBAR_THUMB_ALPHA * (1 - i / SCROLLBAR_FADE_STEPS))
          }
        },
        (SCROLLBAR_FADE_MS / SCROLLBAR_FADE_STEPS) * i
      )
    }
  }

  window.addEventListener(
    'scroll',
    (event) => {
      const el = event.target instanceof Element ? event.target : document.documentElement
      timers.get(el)?.forEach((timer) => window.clearTimeout(timer))
      timers.set(el, [])
      setThumbAlpha(el, SCROLLBAR_THUMB_ALPHA)
      schedule(el, () => fadeOut(el), SCROLLBAR_HIDE_DELAY_MS)
    },
    // Scroll doesn't bubble; capture catches scrolls on any descendant element.
    { capture: true, passive: true }
  )
}
initScrollbarAutoHide()

const root = document.getElementById('root')!
observeWindowFirstFrame(root)
createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
)
