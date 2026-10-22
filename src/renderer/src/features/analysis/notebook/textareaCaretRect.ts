/** Measure a textarea caret using an offscreen mirror with the same wrapping rules. */
export function textareaCaretRect(textarea: HTMLTextAreaElement, offset: number): DOMRect {
  const bounds = textarea.getBoundingClientRect()
  const style = window.getComputedStyle(textarea)
  const mirror = document.createElement('div')
  const marker = document.createElement('span')
  mirror.style.position = 'fixed'
  mirror.style.left = '0'
  mirror.style.top = '0'
  mirror.style.visibility = 'hidden'
  mirror.style.pointerEvents = 'none'
  mirror.style.boxSizing = style.boxSizing
  mirror.style.width = `${bounds.width}px`
  mirror.style.padding = style.padding
  mirror.style.border = style.border
  mirror.style.font = style.font
  mirror.style.lineHeight = style.lineHeight
  mirror.style.letterSpacing = style.letterSpacing
  mirror.style.textIndent = style.textIndent
  mirror.style.textTransform = style.textTransform
  mirror.style.tabSize = style.tabSize
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.overflowWrap = 'break-word'
  mirror.style.wordBreak = style.wordBreak
  mirror.textContent = textarea.value.slice(0, offset)
  marker.textContent = '\u200b'
  mirror.append(marker)
  document.body.append(mirror)
  try {
    const origin = mirror.getBoundingClientRect()
    const caret = marker.getBoundingClientRect()
    return DOMRect.fromRect({
      x: bounds.left + caret.left - origin.left - textarea.scrollLeft,
      y: bounds.top + caret.top - origin.top - textarea.scrollTop,
      width: 1,
      height: caret.height || Number.parseFloat(style.lineHeight) || 18
    })
  } finally {
    mirror.remove()
  }
}
