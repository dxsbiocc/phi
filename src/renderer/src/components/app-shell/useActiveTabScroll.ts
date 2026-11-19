import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Reveal a selected workspace tab without scrolling the surrounding window or stealing focus. */
export function useActiveTabScroll(
  activeTab: string | null,
  tabCount: number
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const strip = ref.current
    const tab = strip?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!strip || !tab) return
    const reveal = (): void => {
      const viewport = strip.getBoundingClientRect()
      const item = tab.getBoundingClientRect()
      if (item.left < viewport.left) strip.scrollLeft += item.left - viewport.left
      else if (item.right > viewport.right) strip.scrollLeft += item.right - viewport.right
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [activeTab, tabCount])
  return ref
}
