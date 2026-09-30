export type NotebookShortcutChord = 'save' | 'format' | 'run' | 'run-and-advance'

function notebookUsesCommandKey(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform)
}

export function notebookCommandLabel(chord: NotebookShortcutChord): string {
  const mod = notebookUsesCommandKey() ? '⌘' : 'Ctrl+'
  if (chord === 'save') return `${mod}S`
  if (chord === 'format') return `${mod}${notebookUsesCommandKey() ? '⇧' : 'Shift+'}F`
  if (chord === 'run') return `${mod}Enter`
  return '⇧Enter'
}

export function isNotebookPromptShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('[data-phi-notebook-ai-prompt-cell]'))
}

export function isNotebookCodeEditorShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('[data-phi-notebook-code-editor="codemirror"]'))
}

export function isNotebookTextEntryShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(
    target.closest(
      'textarea, input, select, [contenteditable="true"], [data-phi-notebook-code-editor="codemirror"], [data-phi-notebook-ai-prompt-cell]'
    )
  )
}
