import { act, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createTheme, ThemeProvider } from '@mui/material'
import { NotebookMarkdownEditor } from '../../src/renderer/src/features/analysis/notebook/NotebookMarkdownEditor'
import { setUiLanguage } from '../../src/renderer/src/lib/i18n'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let draft = 'hello world'
let updateDraft: ((value: string) => void) | null = null
let advances = 0

export function Harness({ dark = false }: { dark?: boolean }): React.JSX.Element {
  const [value, setValue] = useState(draft)
  useEffect(() => {
    updateDraft = setValue
    return () => {
      updateDraft = null
    }
  }, [])
  useEffect(() => {
    draft = value
  }, [value])
  return (
    <ThemeProvider theme={createTheme({ palette: { mode: dark ? 'dark' : 'light' } })}>
      <NotebookMarkdownEditor
        value={value}
        onChange={(next) => {
          draft = next
          setValue(next)
        }}
        onRequestClose={() => undefined}
        onAdvance={() => {
          advances++
        }}
      />
    </ThemeProvider>
  )
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function select(textarea: HTMLTextAreaElement, start: number, end: number): Promise<void> {
  await act(async () => {
    textarea.focus()
    textarea.setSelectionRange(start, end)
    textarea.dispatchEvent(new Event('select', { bubbles: true }))
    textarea.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    document.dispatchEvent(new Event('selectionchange'))
  })
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  check(setter, 'Native textarea setter must be available')
  await act(async () => {
    textarea.focus()
    setter.call(textarea, value)
    textarea.setSelectionRange(value.length, value.length)
    textarea.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
    )
  })
}

async function run(): Promise<object> {
  setUiLanguage('en')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Harness />))
    const textarea = host.querySelector('textarea')
    check(textarea, 'Markdown textarea must mount')
    await select(textarea, 6, 11)
    const toolbar = document.querySelector<HTMLElement>('[data-phi-notebook-markdown-toolbar]')
    check(toolbar, 'Selecting text must open the formatting toolbar')
    const bold = toolbar.querySelector<HTMLButtonElement>('button[aria-label="Bold"]')
    check(bold, 'Bold action must be available in the toolbar')
    const trigger = bold.closest<HTMLElement>('.warm-tooltip__trigger')
    check(trigger, 'WarmTooltip must wrap the formatting action')
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
    })
    const tooltip = document.querySelector<HTMLElement>('.warm-tooltip[role="tooltip"]')
    check(tooltip, 'Hovering a formatting action must reveal WarmTooltip')
    const box = tooltip.querySelector<HTMLElement>('.warm-tooltip__box')
    check(box, `Tooltip surface must render: ${tooltip.outerHTML.slice(0, 400)}`)
    check(
      getComputedStyle(box).backgroundColor === 'rgb(245, 245, 245)',
      'The local CSS adapter must paint the tooltip surface'
    )
    await act(async () => {
      const pointer = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      bold.dispatchEvent(pointer)
      check(pointer.defaultPrevented, 'Toolbar pointer-down must preserve the textarea selection')
      bold.click()
    })
    check(draft === 'hello **world**', 'Bold must wrap the selected text')

    await act(async () => updateDraft?.('/ta'))
    check(host.querySelector('textarea') === textarea, 'Changing content must preserve the editor')
    await select(textarea, 3, 3)
    check(
      document.querySelector('[data-phi-notebook-markdown-slash-menu]'),
      'Typing slash must open the insertion menu'
    )
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
      textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }))
    })
    check(
      !document.querySelector('[data-phi-notebook-markdown-slash-menu]'),
      'Escape must dismiss the slash menu'
    )
    await act(async () => updateDraft?.('/tab'))
    await select(textarea, 4, 4)
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    check(draft.startsWith('| A | B |'), 'Enter must replace the slash command with a table')
    check(!draft.includes('/ta'), 'The slash token must be removed')

    await act(async () => updateDraft?.('/li'))
    await select(textarea, 3, 3)
    const listOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent === 'List'
    )
    check(listOption, 'List must be available in the slash menu')
    await act(async () => {
      listOption.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
      listOption.click()
    })
    check(
      draft === '- item',
      'Clicking a slash choice must insert it without leaving a slash token'
    )
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    await act(async () => updateDraft?.('- first'))
    await select(textarea, 7, 7)
    let listEnterPrevented = false
    await act(async () => {
      const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      textarea.dispatchEvent(key)
      listEnterPrevented = key.defaultPrevented
    })
    check(
      draft === '- first\n- ',
      `Enter must continue the current list: ${JSON.stringify({ draft, listEnterPrevented, selection: textarea.selectionStart, value: textarea.value })}`
    )
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    check(textarea.selectionStart === draft.length, 'The caret must follow the new list marker')

    await act(async () => updateDraft?.('/code'))
    await select(textarea, 5, 5)
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    check(draft === '```text\n\n```', 'The slash command must insert a fenced code block')
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    check(
      textarea.value.slice(textarea.selectionStart, textarea.selectionEnd) === 'text',
      'Code insertion must focus the language slot'
    )
    await act(async () => updateDraft?.('```r\n\n```'))
    await select(textarea, 4, 4)
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    check(textarea.selectionStart === 5, 'Enter after the language must focus the code body')

    await typeInto(textarea, '/ta')
    check(draft === '/ta', 'Typing slash text must update the controlled draft')
    check(
      document.querySelector('[data-phi-notebook-markdown-slash-menu]'),
      'Typing slash text must open the insertion menu without an extra button'
    )
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    check(advances === 1, 'Shift+Enter must retain the Notebook advance shortcut')

    await act(async () => {
      setUiLanguage('zh-CN')
      root.render(<Harness dark />)
    })
    check(
      host.querySelector('textarea') === textarea,
      'Language and theme must retain the editor DOM'
    )
    check(textarea.value === draft, 'Language and theme must retain the draft')
    return { toolbar: true, slashMenu: true, draftRetained: true }
  } finally {
    await act(async () => root.unmount())
    host.remove()
    setUiLanguage('en')
  }
}

run().then(
  (result) => console.log('PHI_MARKDOWN_EDITOR_RESULT:' + JSON.stringify({ ok: true, result })),
  (error: unknown) =>
    console.log(
      'PHI_MARKDOWN_EDITOR_RESULT:' +
        JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) })
    )
)
