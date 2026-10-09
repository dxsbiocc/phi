let firstFrameReady = false

export function syncWindowBackground(background: string): void {
  if (firstFrameReady) {
    void window.api?.readyWindow?.(background).catch((error: unknown) => {
      console.error('Window appearance update failed:', error)
    })
  }
}

// A module/HTML load is not a usable app frame. Observe React's committed
// content (including its error fallback), then let styles, fonts and paint settle.
export function observeWindowFirstFrame(root: HTMLElement): void {
  const content = (): Element | undefined =>
    Array.from(root.children).find((element) => !['STYLE', 'LINK'].includes(element.tagName))
  let scheduled = false
  const observer = new MutationObserver(() => schedule())
  const schedule = (): void => {
    if (scheduled || !content()) return
    scheduled = true
    void Promise.resolve(document.fonts?.ready).then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const element = content()
          if (!element) {
            scheduled = false
            return
          }
          observer.disconnect()
          // The error page owns its background; normal app chrome uses CssBaseline.
          const elementBackground = getComputedStyle(element).backgroundColor
          const background =
            elementBackground === 'rgba(0, 0, 0, 0)' || elementBackground === 'transparent'
              ? getComputedStyle(document.body).backgroundColor
              : elementBackground
          firstFrameReady = true
          syncWindowBackground(background)
        })
      })
    })
  }
  observer.observe(root, { childList: true })
  schedule()
}
