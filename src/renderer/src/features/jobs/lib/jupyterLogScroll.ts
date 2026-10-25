/** Following a log must never scroll the surrounding task detail pane. */
export function scrollJupyterLogToEnd(
  viewport: Pick<HTMLElement, 'scrollTop' | 'scrollHeight'> | null
): void {
  if (viewport) viewport.scrollTop = viewport.scrollHeight
}
