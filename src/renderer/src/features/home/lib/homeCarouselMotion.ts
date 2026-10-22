export const HOME_CAROUSEL_SLIDE_MS = 480

export type SlideDirection = 1 | -1

/** Where each stacked card sits while the carousel slides. Both stay mounted so the frame keeps the taller card's height. */
export function carouselSlideMotion(
  slideIndex: number,
  active: number,
  incoming: number | null,
  direction: SlideDirection,
  animate: boolean
): { transform: string; transition: string } {
  const enter = `translateX(${direction * 100}%)`
  const exit = `translateX(${direction * -100}%)`
  const transition = animate
    ? `transform ${HOME_CAROUSEL_SLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`
    : 'none'
  // Park the next card on the entry side before enabling the transition, or a wrap slides back across the frame.
  if (incoming !== null && !animate) {
    if (slideIndex === incoming) return { transform: enter, transition: 'none' }
    if (slideIndex === active) return { transform: 'translateX(0)', transition: 'none' }
  }
  if (slideIndex === active) return { transform: 'translateX(0)', transition }
  return { transform: exit, transition }
}
