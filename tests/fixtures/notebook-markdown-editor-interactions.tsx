import { act, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createTheme, ThemeProvider } from '@mui/material'
import { EditorView } from '@codemirror/view'
import { WebLinkOpenContext } from '../../src/renderer/src/components/markdown/WebLinkOpenContext'
import { NotebookMarkdownEditor } from '../../src/renderer/src/features/analysis/notebook/NotebookMarkdownEditor'
import { setUiLanguage } from '../../src/renderer/src/lib/i18n'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let draft = 'hello world'
let advances = 0

export function Harness({ dark = false }: { dark?: boolean }): React.JSX.Element {
  const [value, setValue] = useState(draft)
  useEffect(() => {
    draft = value
  }, [value])
  return (
    <ThemeProvider theme={createTheme({ palette: { mode: dark ? 'dark' : 'light' } })}>
      <WebLinkOpenContext.Provider value={() => undefined}>
        <NotebookMarkdownEditor
          value={value}
          onChange={(next) => {
            draft = next
            setValue(next)
          }}
          onAdvance={() => {
            advances++
          }}
        />
      </WebLinkOpenContext.Provider>
    </ThemeProvider>
  )
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function frame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

async function select(view: EditorView, start: number, end = start): Promise<void> {
  await act(async () => {
    view.focus()
    view.dispatch({ selection: { anchor: start, head: end } })
  })
  await frame()
}

async function setSource(view: EditorView, source: string): Promise<void> {
  await act(async () => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: source },
      selection: { anchor: source.length }
    })
  })
  await frame()
}

async function press(
  view: EditorView,
  key: string,
  options: KeyboardEventInit = {}
): Promise<void> {
  await act(async () => {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
    )
  })
  await frame()
}

async function typeCode(input: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  check(setter, 'Native textarea setter must be available')
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
    )
  })
  await frame()
}

async function typeLanguageSearch(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  check(setter, 'Native input setter must be available')
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
    )
  })
  await frame()
}

async function run(): Promise<object> {
  setUiLanguage('en')
  const regressions: string[] = []
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Harness />))
    await frame()
    const editorDom = host.querySelector<HTMLElement>('.cm-editor')
    check(editorDom, 'The live Markdown cell must mount CodeMirror')
    const view = EditorView.findFromDOM(editorDom)
    check(view, 'The CodeMirror view must be discoverable')
    check(view.state.doc.toString() === draft, 'The Markdown source must remain intact')
    check(
      host.querySelector('.cm-line')?.textContent?.includes('hello world'),
      'An unfocused Markdown paragraph must remain in the editable layout'
    )

    await select(view, 6, 11)
    const toolbar = document.querySelector<HTMLElement>('[data-phi-notebook-markdown-toolbar]')
    check(toolbar, 'Selecting text must open the formatting toolbar')
    const bold = toolbar.querySelector<HTMLButtonElement>('button[aria-label="Bold"]')
    check(bold, 'Bold action must be available')
    const trigger = bold.closest<HTMLElement>('.warm-tooltip__trigger')
    check(trigger, 'WarmTooltip must wrap the formatting action')
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
    })
    const tooltip = document.querySelector<HTMLElement>('.warm-tooltip[role="tooltip"]')
    check(tooltip, 'Hovering formatting must reveal WarmTooltip')
    const box = tooltip.querySelector<HTMLElement>('.warm-tooltip__box')
    check(box, 'The tooltip surface must render')
    check(getComputedStyle(box).backgroundColor === 'rgb(245, 245, 245)', 'Tooltip CSS must load')
    await act(async () => {
      bold.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
      bold.click()
    })
    check(draft === 'hello **world**', 'Bold must wrap selected source')
    await press(view, 'z', { metaKey: true })
    check(draft === 'hello world', 'Undo must restore the source after formatting')

    await setSource(view, '# Title\n\nParagraph **bold**.')
    await select(view, 15)
    if (!host.querySelector('.cm-line.phi-inline-heading-1'))
      regressions.push('The heading switches from a rendered widget to an editor line on focus')
    check(
      host.querySelector('.cm-line.phi-inline-heading-1')?.textContent?.includes('Title'),
      'The heading must stay styled while the paragraph is edited'
    )
    await select(view, 1)
    if (view.contentDOM.textContent?.includes('# Title'))
      regressions.push('Clicking a heading reveals raw # syntax')
    await select(view, view.state.doc.toString().indexOf('bold') + 1)
    if (view.contentDOM.textContent?.includes('**bold**'))
      regressions.push('Clicking emphasized text reveals raw ** syntax')
    await setSource(view, '')
    await act(async () =>
      view.dispatch({ changes: { from: 0, insert: '#' }, selection: { anchor: 1 } })
    )
    await act(async () =>
      view.dispatch({ changes: { from: 1, insert: ' ' }, selection: { anchor: 2 } })
    )
    await frame()
    check(
      host.querySelector('.cm-line.phi-inline-heading-1'),
      'Typing # then space must create an H1'
    )
    await act(async () =>
      view.dispatch({ changes: { from: 2, insert: 'Title' }, selection: { anchor: 7 } })
    )
    await frame()
    check(
      host.querySelector('.cm-line.phi-inline-heading-1')?.textContent === 'Title',
      'Typing # followed by a space must remain a rendered H1 while entering its title'
    )
    await setSource(view, '- cost $$O(n)$$\n- second\n\nAfter')
    await select(view, 8)
    const inlineFormula = host.querySelector<HTMLElement>('[data-phi-notebook-inline-formula]')
    if (!inlineFormula)
      regressions.push('Inline formulas are not rendered while editing their list')
    else {
      await act(async () => inlineFormula.click())
      const inlineInputRoot = document.querySelector<HTMLElement>(
        '[data-phi-notebook-inline-formula-input]'
      )
      const inlineInput = inlineInputRoot?.querySelector('input')
      check(inlineInput, 'Clicking inline math must open its expression input')
      await typeLanguageSearch(inlineInput, 'O(n^2)')
      check(draft.includes('$$O(n^2)$$'), 'Inline math edits must preserve the rendered formula')
      check(
        host.querySelector('[data-phi-notebook-inline-formula]'),
        'Inline math must stay rendered'
      )
      check(
        document.querySelector('[data-phi-notebook-inline-formula-input] input') === inlineInput,
        'Inline formula typing must keep the same input node'
      )
    }
    await setSource(view, '- cost $$O(n)$$\n\nAfter')
    await select(view, 8)
    check(
      host.querySelector('[data-phi-notebook-inline-formula] .katex'),
      'Double-dollar math inside a list must remain an inline rendered formula'
    )
    await select(view, 1)
    check(
      !view.contentDOM.textContent?.includes('- cost'),
      'Clicking a list marker must keep the rendered bullet'
    )
    await setSource(view, '$$\nE = mc^2\n$$\n\nAfter')
    await select(view, 5)
    const formulaBlock = host.querySelector<HTMLElement>('[data-phi-notebook-formula-block]')
    if (!formulaBlock)
      regressions.push('Clicking a formula reveals raw source instead of its component')
    else {
      const formulaPreview = formulaBlock.querySelector<HTMLElement>('[role="button"]')
      check(formulaPreview, 'Display math must expose an edit target')
      const heightBeforeEdit = formulaBlock.getBoundingClientRect().height
      await act(async () => formulaPreview.click())
      const formulaInput = formulaBlock.querySelector<HTMLTextAreaElement>(
        '[data-phi-notebook-formula-input]'
      )
      check(formulaInput, 'Clicking display math must open an input inside the formula component')
      check(
        formulaBlock.getBoundingClientRect().height === heightBeforeEdit,
        'Editing a formula must not change the block height or move surrounding content'
      )
      await typeCode(formulaInput, 'a^2 + b^2')
      check(draft.includes('$$\na^2 + b^2\n$$'), 'Display math edits must update Markdown source')
      check(
        formulaBlock.querySelector('[data-phi-notebook-formula-input]') === formulaInput,
        'Formula typing must keep the same input node'
      )
    }
    await setSource(view, '/formula')
    await select(view, view.state.doc.length)
    await press(view, 'Enter')
    const insertedFormula = host.querySelector<HTMLTextAreaElement>(
      '[data-phi-notebook-formula-input]'
    )
    check(
      insertedFormula && document.activeElement === insertedFormula,
      'Inserting a formula must focus its expression input without exposing $$'
    )
    await setSource(view, '```r\nx <- 1\n```\n\nParagraph')
    await select(view, view.state.doc.length)
    check(
      host.querySelector('[data-phi-notebook-code-block="editable"]'),
      'Fenced code must remain an editable block while another paragraph is active'
    )
    await setSource(view, '[Google](https://www.google.com/)\n\nParagraph')
    await select(view, view.state.doc.length)
    check(
      host
        .querySelector('a[href="https://www.google.com/"]')
        ?.getAttribute('data-phi-open-web-url') === 'in-app',
      'Rendered links must keep the in-app opener'
    )

    await setSource(view, '/ta')
    check(
      document.querySelector('[data-phi-notebook-markdown-slash-menu]'),
      'Slash text must open the insertion menu'
    )
    check(
      view.contentDOM.getAttribute('aria-expanded') === 'true' &&
        view.contentDOM.hasAttribute('aria-activedescendant'),
      'The slash list must be linked to the editable surface'
    )
    await press(view, 'Escape')
    check(
      !document.querySelector('[data-phi-notebook-markdown-slash-menu]'),
      'Escape must dismiss the menu'
    )
    await setSource(view, '/tab')
    await press(view, 'Enter')
    check(draft.startsWith('| A | B |'), 'Enter must replace slash command with a table')
    check(!draft.includes('/ta'), 'The slash token must be removed')

    await setSource(view, '/')
    for (let index = 0; index < 8; index++) await press(view, 'ArrowDown')
    const slashPaper = document.querySelector<HTMLElement>(
      '[data-phi-notebook-markdown-slash-menu]'
    )
    check(
      slashPaper && slashPaper.scrollTop > 0,
      `The slash menu must scroll with the active option: ${JSON.stringify({ scrollTop: slashPaper?.scrollTop, scrollHeight: slashPaper?.scrollHeight, clientHeight: slashPaper?.clientHeight, active: view.contentDOM.getAttribute('aria-activedescendant') })}`
    )

    await setSource(view, '/li')
    const listOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent === 'List'
    )
    check(listOption, 'The List option must be available')
    await act(async () => {
      listOption.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
      listOption.click()
    })
    check(draft === '- item', 'Clicking a slash choice must insert the selected block')

    await setSource(view, '- first')
    await press(view, 'Enter')
    check(draft === '- first\n- ', 'Enter must continue the current list')

    await setSource(view, '/code')
    await press(view, 'Enter')
    check(draft === '```\n\n```\n\n', 'Code command must leave a paragraph after the block')
    const codeInput = host.querySelector<HTMLTextAreaElement>('[data-phi-notebook-code-input]')
    check(codeInput, 'Code insertion must open an editable area')
    check(document.activeElement === codeInput, 'The new code area must receive focus')
    const firstCodeWidget = codeInput.closest('.phi-inline-markdown-block')
    await typeCode(codeInput, 'x')
    const nextCodeInput = host.querySelector<HTMLTextAreaElement>('[data-phi-notebook-code-input]')
    check(
      nextCodeInput && document.activeElement === nextCodeInput,
      'The first code keystroke must keep focus'
    )
    if (nextCodeInput !== codeInput) regressions.push('Each code keystroke replaces its input node')
    if (nextCodeInput?.closest('.phi-inline-markdown-block') !== firstCodeWidget)
      regressions.push('CodeMirror replaces the code widget DOM')
    if (EditorView.findFromDOM(editorDom) !== view)
      regressions.push('React replaces the whole CodeMirror editor')
    await typeCode(nextCodeInput, 'x <- 1')
    check(draft === '```\nx <- 1\n```\n\n', 'Typing in the block must update Markdown source')
    const currentCodeInput = host.querySelector<HTMLTextAreaElement>(
      '[data-phi-notebook-code-input]'
    )
    check(
      currentCodeInput &&
        document.activeElement === currentCodeInput &&
        currentCodeInput.value === 'x <- 1' &&
        currentCodeInput === codeInput,
      'Typing must keep focus and the complete code body'
    )
    const languageButton = host.querySelector<HTMLButtonElement>(
      '[data-phi-notebook-code-language-button]'
    )
    check(languageButton, 'The code block must expose a language button')
    await act(async () => languageButton.click())
    const rOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent === 'R'
    )
    check(rOption, 'R must be offered as a code language')
    await act(async () => rOption.click())
    check(draft === '```r\nx <- 1\n```\n\n', 'Language selection must update the opening fence')
    const updatedLanguageButton = host.querySelector<HTMLButtonElement>(
      '[data-phi-notebook-code-language-button]'
    )
    check(updatedLanguageButton, 'The language button must survive a language change')
    await act(async () => updatedLanguageButton.click())
    const search = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search languages…"]'
    )
    check(search, 'The language menu must expose search')
    await typeLanguageSearch(search, 'Haskell')
    const customOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent === 'Use haskell'
    )
    check(customOption, 'An unlisted language must still be selectable')
    await act(async () => customOption.click())
    check(draft === '```haskell\nx <- 1\n```\n\n', 'Custom language must preserve code body')
    const resetButton = host.querySelector<HTMLButtonElement>(
      '[data-phi-notebook-code-language-button]'
    )
    check(resetButton, 'The custom language button must remain usable')
    await act(async () => resetButton.click())
    const resetOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent === 'R'
    )
    check(resetOption, 'The language menu must still offer R')
    await act(async () => resetOption.click())
    const afterLanguageInput = host.querySelector<HTMLTextAreaElement>(
      '[data-phi-notebook-code-input]'
    )
    check(afterLanguageInput, 'Language selection must keep the code input')
    await act(async () => {
      afterLanguageInput.focus()
      afterLanguageInput.setSelectionRange(
        afterLanguageInput.value.length,
        afterLanguageInput.value.length
      )
      afterLanguageInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    })
    check(view.hasFocus, 'ArrowDown at the end of code must focus the paragraph below')
    const paragraph = view.state.selection.main.head
    await act(async () => view.dispatch({ changes: { from: paragraph, insert: 'after' } }))
    check(draft === '```r\nx <- 1\n```\n\nafter', 'Text after code must remain outside the fence')

    await setSource(view, '/ta')
    await press(view, 'Enter', { shiftKey: true })
    check(advances === 1, 'Shift+Enter must retain the Notebook advance shortcut')
    check(!view.hasFocus, 'Advancing must release focus from the previous Markdown cell')

    const previousView = view
    await act(async () => {
      setUiLanguage('zh-CN')
      root.render(<Harness dark />)
    })
    check(
      EditorView.findFromDOM(editorDom) === previousView,
      'Theme switching must retain the view'
    )
    check(view.state.doc.toString() === draft, 'Theme switching must retain the draft')
    check(regressions.length === 0, regressions.join('; '))
    return { liveRendering: true, toolbar: true, slashMenu: true, draftRetained: true }
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
