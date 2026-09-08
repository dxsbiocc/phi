export type AppShortcutAction = 'new-chat' | 'focus-primary-input' | 'close-dialogs'

type ShortcutLikeEvent = {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
  target?: EventTarget | null
}

function isEditableTarget(target: EventTarget | null | undefined): boolean {
  if (typeof HTMLElement === 'undefined') return false
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

export function getAppShortcutAction(event: ShortcutLikeEvent): AppShortcutAction | null {
  if (event.isComposing) return null

  if (event.key === 'Escape') return 'close-dialogs'

  const hasCommandModifier = Boolean(event.metaKey || event.ctrlKey)
  if (!hasCommandModifier || event.altKey) return null

  const key = event.key.toLowerCase()
  if (key === 'n' && !event.shiftKey) return 'new-chat'
  if (key === 'k' && !event.shiftKey && !isEditableTarget(event.target)) {
    return 'focus-primary-input'
  }

  return null
}
