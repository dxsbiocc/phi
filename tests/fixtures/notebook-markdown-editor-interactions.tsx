import { act, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createTheme, ThemeProvider } from '@mui/material'
import { EditorView } from '@codemirror/view'
import { WebLinkOpenContext } from '../../src/renderer/src/components/markdown/WebLinkOpenContext'
import { NotebookMarkdownEditor } from '../../src/renderer/src/features/analysis/notebook/NotebookMarkdownEditor'
import NotebookCell from '../../src/renderer/src/features/analysis/notebook/NotebookCell'
import { setUiLanguage } from '../../src/renderer/src/lib/i18n'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let draft = 'hello world'
let advances = 0
let cellDraft = '$$\nE=mc^2\n$$\n\nafna\n\n```\n\n```\n\nAfter'

function CellHarness(): React.JSX.Element {
  const [source, setSource] = useState(cellDraft)
  const [selected, setSelected] = useState(false)
  return (
    <ThemeProvider theme={createTheme()}>
      <NotebookCell
        cell={{
          id: 'markdown-cell',
          count: null,
          type: 'markdown',
          state: 'idle',
          source,
          outputs: []
        }}
        editable
        selected={selected}
        onSelectCell={() => setSelected(true)}
        onSourceChange={(_cellId, next) => {
          cellDraft = next
          setSource(next)
        }}
      />
    </ThemeProvider>
  )
}

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

function codeInputView(root: ParentNode): EditorView {
  const dom = root.querySelector<HTMLElement>('[data-phi-notebook-code-input] .cm-editor')
  check(dom, 'The code block must mount a visible CodeMirror editor')
  const view = EditorView.findFromDOM(dom)
  check(view, 'The code block editor must be discoverable')
  return view
}

async function typeCodeView(view: EditorView, value: string): Promise<void> {
  await act(async () => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: value.length }
    })
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
      check(heightBeforeEdit >= 160, 'A display formula must leave room for its preview and input')
      await act(async () => formulaBlock.click())
      check(
        formulaBlock.querySelector('[data-phi-notebook-formula-input]'),
        'Clicking any blank part of the formula block must open its input'
      )
      await act(async () => formulaPreview.click())
      const formulaInput = formulaBlock.querySelector<HTMLTextAreaElement>(
        '[data-phi-notebook-formula-input]'
      )
      check(formulaInput, 'Clicking display math must open an input inside the formula component')
      if (document.activeElement !== formulaInput)
        regressions.push('Clicking a display formula does not focus its expression input')
      check(
        formulaBlock.getBoundingClientRect().height === heightBeforeEdit,
        'Editing a formula must not change the block height or move surrounding content'
      )
      await new Promise((resolve) => setTimeout(resolve, 150))
      check(
        getComputedStyle(formulaBlock).backgroundColor !== 'rgba(0, 0, 0, 0)',
        'The selected formula must have a visible background'
      )
      for (const key of [' ', 'Enter']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        await act(async () => formulaInput.dispatchEvent(event))
        check(
          !event.defaultPrevented,
          `Formula input must accept ${key === ' ' ? 'spaces' : 'newlines'}`
        )
      }
      await typeCode(formulaInput, 'a^2 + b^2')
      check(draft.includes('$$\na^2 + b^2\n$$'), 'Display math edits must update Markdown source')
      check(
        formulaBlock.querySelector('[data-phi-notebook-formula-input]') === formulaInput,
        'Formula typing must keep the same input node'
      )
      await typeCode(formulaInput, '')
      await act(async () => {
        formulaInput.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
        )
      })
      if (draft.includes('$$'))
        regressions.push('Backspace in an empty display formula cannot delete its block')
    }
    await setSource(view, '$$\nE = mc^2\n$$\n\nAfter')
    const exitPreview = host.querySelector<HTMLElement>(
      '[data-phi-notebook-formula-block] [role="button"]'
    )
    check(exitPreview, 'The formula preview must remain editable')
    await act(async () => exitPreview.click())
    const exitInput = host.querySelector<HTMLTextAreaElement>('[data-phi-notebook-formula-input]')
    check(exitInput, 'The formula expression input must open')
    exitInput.setSelectionRange(exitInput.value.length, exitInput.value.length)
    await act(async () => {
      exitInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    })
    check(view.hasFocus, 'ArrowDown at the end of a formula must focus the paragraph below')
    const deleteFormulaButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete formula"]'
    )
    check(deleteFormulaButton, 'A display formula must expose a delete action')
    await act(async () => deleteFormulaButton.click())
    check(draft === 'After', 'The formula delete action must remove the whole block')
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
    check(draft.endsWith('$$\n\n\n'), 'A new formula must leave a writable line below')
    const formulaFooter = host.querySelector<HTMLElement>('[data-phi-notebook-markdown-footer]')
    check(formulaFooter, 'A formula at the end must offer a writable footer')
    await act(async () => {
      formulaFooter.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      )
    })
    check(
      view.state.selection.main.head === view.state.doc.length,
      'Clicking below the formula must put the caret after it'
    )
    await setSource(view, '# Title\n\n$\n\n- Item\n\nAfter')
    await select(view, 10)
    await act(async () => {
      check(document.execCommand('insertText', false, '$'), 'A typed dollar sign must be accepted')
    })
    await frame()
    check(
      draft === '# Title\n\n$$\n\n$$\n\n\n- Item\n\nAfter',
      'Typing a second dollar sign must insert a bounded formula without swallowing the list'
    )
    const shortcutFormulaInput = host.querySelector<HTMLTextAreaElement>(
      '[data-phi-notebook-formula-input]'
    )
    check(
      shortcutFormulaInput && document.activeElement === shortcutFormulaInput,
      'The new formula must receive the caret inside its input'
    )
    check(
      host.querySelector('[data-phi-notebook-formula-block]') &&
        host.querySelector('.cm-line')?.textContent?.includes('Title') &&
        view.state.doc.toString().includes('- Item\n\nAfter'),
      'The heading, list and trailing paragraph must remain outside the new formula'
    )
    await setSource(view, 'Before\n$$\nE=mc^2\n$$\nAfter')
    check(
      host.querySelector('[data-phi-notebook-formula-block]') &&
        view.contentDOM.textContent?.includes('Before') &&
        view.contentDOM.textContent?.includes('After'),
      'Adjacent paragraphs must render on both sides of a bounded formula'
    )
    await setSource(view, '```r\nx <- 1\n```\n\nParagraph')
    await select(view, view.state.doc.length)
    check(
      host.querySelector('[data-phi-notebook-code-block="editable"]'),
      'Fenced code must remain an editable block while another paragraph is active'
    )
    await setSource(view, '```python\nimport pandas as pd\n```\n\n\n')
    check(
      host.querySelector('[data-phi-notebook-code-highlight] [data-phi-syntax-token="keyword"]'),
      'Python code inside Markdown must receive language-specific keyword coloring'
    )
    await setSource(view, '```python\nif ready:\n```\n\n\n')
    const indentCodeView = codeInputView(host)
    indentCodeView.focus()
    indentCodeView.dispatch({ selection: { anchor: indentCodeView.state.doc.length } })
    await press(indentCodeView, 'Enter')
    check(
      draft === '```python\nif ready:\n\t\n```\n\n\n',
      'Enter in a Markdown code block must create a Tab-indented line'
    )
    await press(indentCodeView, 'Tab')
    check(
      draft === '```python\nif ready:\n\t\t\n```\n\n\n',
      'Tab in a Markdown code block must insert a literal Tab'
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

    await setSource(view, '# Title\n\n[Link](https://example.com)')
    check(
      host.querySelector('[data-phi-notebook-markdown-footer]'),
      'A link at the end must leave a clickable writing area below it'
    )

    await setSource(view, '/link')
    await press(view, 'Enter')
    const linkEditor = document.querySelector<HTMLElement>('[data-phi-notebook-link-editor]')
    check(linkEditor, 'The Link command must open a title and URL form')
    check(draft === '', 'Selecting Link must remove the slash command before editing fields')
    const linkTitle = linkEditor.querySelector<HTMLInputElement>('[data-phi-notebook-link-title]')
    const linkUrl = linkEditor.querySelector<HTMLInputElement>('[data-phi-notebook-link-url]')
    check(linkTitle && linkUrl, 'The link form must expose both title and URL inputs')
    await typeLanguageSearch(linkTitle, 'Data source')
    await typeLanguageSearch(linkUrl, 'https://example.com/data')
    const insertLink = linkEditor.querySelector<HTMLButtonElement>(
      '[data-phi-notebook-link-submit]'
    )
    check(insertLink, 'The link form must expose an insert action')
    await act(async () => insertLink.click())
    check(
      draft.startsWith('[Data source](https://example.com/data)'),
      'Link fields must become one Markdown link'
    )

    await setSource(view, 'Visit dataset')
    await select(view, 6, 13)
    const selectedLinkButton = document.querySelector<HTMLButtonElement>(
      '[data-phi-notebook-markdown-toolbar] button[aria-label="Link"]'
    )
    check(selectedLinkButton, 'Selected text must offer the Link formatting action')
    await act(async () => selectedLinkButton.click())
    const selectedLinkEditor = document.querySelector<HTMLElement>(
      '[data-phi-notebook-link-editor]'
    )
    const selectedTitle = selectedLinkEditor?.querySelector<HTMLInputElement>(
      '[data-phi-notebook-link-title]'
    )
    const selectedUrl = selectedLinkEditor?.querySelector<HTMLInputElement>(
      '[data-phi-notebook-link-url]'
    )
    check(
      selectedTitle?.value === 'dataset' && selectedUrl,
      'Selected text must prefill the link title'
    )
    await typeLanguageSearch(selectedUrl, 'https://example.com/dataset')
    const selectedInsert = selectedLinkEditor?.querySelector<HTMLButtonElement>(
      '[data-phi-notebook-link-submit]'
    )
    check(selectedInsert, 'The selected-text link form must be submittable')
    await act(async () => selectedInsert.click())
    check(
      draft === 'Visit [dataset](https://example.com/dataset)',
      'Link insertion must preserve surrounding text'
    )

    await setSource(view, '# Title\n\n[Link](https://example.com)')
    const linkFooter = host.querySelector<HTMLElement>('[data-phi-notebook-markdown-footer]')
    check(linkFooter, 'Every editable Markdown cell needs a clickable area below its last block')
    await act(async () => {
      linkFooter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    check(
      view.state.selection.main.head === view.state.doc.length,
      'The footer must place the caret after the link'
    )
    await act(async () => {
      check(
        document.execCommand('insertText', false, 'after'),
        'Typing after the link must be accepted'
      )
    })
    await frame()
    check(
      draft === '# Title\n\n[Link](https://example.com)\n\nafter',
      'Footer typing must create a paragraph outside the link'
    )

    await setSource(view, '- first')
    await press(view, 'Enter')
    check(draft === '- first\n- ', 'Enter must continue the current list')

    await setSource(view, '/code')
    await press(view, 'Enter')
    check(
      draft === '```\n\n```\n\n\n',
      'Code command must leave two writable lines after the block'
    )
    const codeInput = host.querySelector<HTMLElement>('[data-phi-notebook-code-input]')
    check(codeInput, 'Code insertion must open an editable area')
    const insertedCodeView = codeInputView(host)
    check(insertedCodeView.hasFocus, 'The new code area must receive focus')
    const insertedCaret = codeInput.querySelector<HTMLElement>('.cm-cursor')
    check(
      insertedCaret && insertedCaret.getBoundingClientRect().height > 0,
      'The focused empty code block must paint a visible insertion cursor'
    )
    check(
      getComputedStyle(insertedCaret).borderLeftWidth !== '0px' &&
        getComputedStyle(insertedCaret).borderLeftColor !== 'rgba(0, 0, 0, 0)',
      'The code caret must use a visible theme-colored stroke'
    )
    const emptyCodeBlock = codeInput.closest<HTMLElement>('[data-phi-notebook-code-block]')
    check(emptyCodeBlock, 'The code input must be inside its block')
    check(
      getComputedStyle(insertedCodeView.contentDOM).color !== 'rgba(0, 0, 0, 0)',
      'The editable code surface must display the characters being typed'
    )
    const emptyCodeHeight = emptyCodeBlock.getBoundingClientRect().height
    const codeRect = codeInput.getBoundingClientRect()
    check(
      codeInput.contains(document.elementFromPoint(codeRect.left + 20, codeRect.bottom - 18)),
      'The visible code surface must receive pointer input'
    )
    await act(async () => {
      insertedCodeView.focus()
      check(document.execCommand('insertText', false, 'x'), 'Native code typing must be accepted')
    })
    await frame()
    check(draft === '```\nx\n```\n\n\n', 'Native typing must update the code block source')
    await setSource(view, '```\n\n```\n\nAfter')
    await select(view, view.state.doc.length)
    const clickInput = host.querySelector<HTMLElement>('[data-phi-notebook-code-input]')
    check(clickInput, 'An existing code block must remain editable')
    const clickRect = clickInput.getBoundingClientRect()
    console.log(
      'PHI_CODE_CLICK:' +
        JSON.stringify({ x: clickRect.left + 22, y: clickRect.top + 58, key: 'y' })
    )
    await new Promise((resolve) => setTimeout(resolve, 350))
    check(codeInputView(host).hasFocus, 'Clicking an existing block must focus its input')
    check(
      draft === '```\ny\n```\n\nAfter',
      'Typing after clicking an existing code block must change its body'
    )
    await setSource(view, '$$\nE=mc^2\n$$\n\nafna\n\n```\n\n```\n\nAfter')
    const priorFormula = host.querySelector<HTMLElement>(
      '[data-phi-notebook-formula-block] [role="button"]'
    )
    check(priorFormula, 'The formula before code must render')
    await act(async () => priorFormula.click())
    const mixedCodeInput = host.querySelector<HTMLElement>('[data-phi-notebook-code-input]')
    check(mixedCodeInput, 'The code block after a formula must render')
    mixedCodeInput.scrollIntoView()
    const mixedRect = mixedCodeInput.getBoundingClientRect()
    console.log(
      'PHI_CODE_CLICK:' +
        JSON.stringify({ x: mixedRect.left + 22, y: mixedRect.top + 58, key: 'z' })
    )
    await new Promise((resolve) => setTimeout(resolve, 350))
    check(codeInputView(host).hasFocus, 'The code input must take focus from the formula')
    check(draft.includes('```\nz\n```'), 'Code after a selected formula must accept typing')
    const cellHost = document.createElement('div')
    document.body.append(cellHost)
    const cellRoot = createRoot(cellHost)
    await act(async () => cellRoot.render(<CellHarness />))
    await frame()
    const cellCodeInput = cellHost.querySelector<HTMLElement>('[data-phi-notebook-code-input]')
    check(cellCodeInput, 'The complete notebook cell must show the Markdown code input')
    cellCodeInput.scrollIntoView()
    const cellCodeRect = cellCodeInput.getBoundingClientRect()
    console.log(
      'PHI_CODE_CLICK:' +
        JSON.stringify({ x: cellCodeRect.left + 22, y: cellCodeRect.top + 58, key: 'q' })
    )
    await new Promise((resolve) => setTimeout(resolve, 350))
    check(codeInputView(cellHost).hasFocus, 'Notebook selection must preserve code input focus')
    check(
      cellCodeInput.querySelector('.cm-cursor'),
      'Clicking code in a notebook cell must paint its insertion cursor'
    )
    check(cellDraft.includes('```\nq\n```'), 'The actual notebook cell must save typed code')
    await act(async () => cellRoot.unmount())
    cellHost.remove()
    cellDraft = '# Title\n\n[Link](https://example.com)'
    const linkCellHost = document.createElement('div')
    document.body.append(linkCellHost)
    const linkCellRoot = createRoot(linkCellHost)
    await act(async () => linkCellRoot.render(<CellHarness />))
    await frame()
    const linkCellFooter = linkCellHost.querySelector<HTMLElement>(
      '[data-phi-notebook-markdown-footer]'
    )
    check(linkCellFooter, 'A rendered Notebook cell must show a footer below the final link')
    linkCellFooter.scrollIntoView()
    await frame()
    const linkFooterRect = linkCellFooter.getBoundingClientRect()
    const visibleLink = linkCellHost.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com"]'
    )
    const linkBottom = visibleLink?.getBoundingClientRect().bottom ?? linkFooterRect.top
    const blankGap = linkFooterRect.top - linkBottom
    const clickY = blankGap > 12 ? linkBottom + blankGap / 2 : linkFooterRect.top + 14
    console.log(
      'PHI_CODE_CLICK:' +
        JSON.stringify({
          x: linkFooterRect.left + 80,
          y: clickY,
          key: 'z'
        })
    )
    await new Promise((resolve) => setTimeout(resolve, 350))
    check(
      cellDraft === '# Title\n\n[Link](https://example.com)\n\nz',
      'Clicking below a link must write a new paragraph'
    )
    await act(async () => linkCellRoot.unmount())
    linkCellHost.remove()
    await setSource(view, '```\n\n```\n\n\n')
    const editCodeView = codeInputView(host)
    editCodeView.focus()
    const codeActions = host.querySelector<HTMLElement>('.phi-notebook-code-actions')
    check(codeActions, 'The code block actions must be mounted')
    await new Promise((resolve) => setTimeout(resolve, 150))
    check(getComputedStyle(codeActions).opacity === '1', 'Focused code actions must be visible')
    check(emptyCodeHeight <= 84, 'An empty code block must not reserve extra input height')
    const firstCodeInput = host.querySelector<HTMLElement>('[data-phi-notebook-code-input]')
    check(firstCodeInput, 'The code input must remain mounted')
    const firstCodeWidget = firstCodeInput.closest('.phi-inline-markdown-block')
    await typeCodeView(editCodeView, 'x')
    const nextCodeInput = host.querySelector<HTMLElement>('[data-phi-notebook-code-input]')
    check(nextCodeInput && codeInputView(host).hasFocus, 'The first code keystroke must keep focus')
    if (nextCodeInput !== firstCodeInput)
      regressions.push('Each code keystroke replaces its input node')
    if (nextCodeInput.closest('.phi-inline-markdown-block') !== firstCodeWidget)
      regressions.push('CodeMirror replaces the code widget DOM')
    if (EditorView.findFromDOM(editorDom) !== view)
      regressions.push('React replaces the whole CodeMirror editor')
    await typeCodeView(editCodeView, 'one\ntwo\nthree')
    check(
      (nextCodeInput.closest<HTMLElement>('[data-phi-notebook-code-block]')?.getBoundingClientRect()
        .height ?? 0) > emptyCodeHeight,
      'The code block must grow when code lines are added'
    )
    await typeCodeView(editCodeView, 'x <- 1')
    check(draft === '```\nx <- 1\n```\n\n\n', 'Typing in the block must update Markdown source')
    const currentCodeInput = host.querySelector<HTMLElement>('[data-phi-notebook-code-input]')
    check(
      currentCodeInput &&
        editCodeView.hasFocus &&
        editCodeView.state.doc.toString() === 'x <- 1' &&
        currentCodeInput === firstCodeInput,
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
    check(draft === '```r\nx <- 1\n```\n\n\n', 'Language selection must update the opening fence')
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
    check(draft === '```haskell\nx <- 1\n```\n\n\n', 'Custom language must preserve code body')
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
    if (!host.querySelector('[data-phi-notebook-code-highlight] [data-phi-syntax-token]'))
      regressions.push('The editable code block has no syntax-highlighted layer')
    const afterLanguageInput = codeInputView(host)
    const footer = host.querySelector<HTMLElement>('[data-phi-notebook-markdown-footer]')
    check(footer, 'A code block at the end must offer a writable footer')
    await act(async () => {
      footer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    check(
      view.state.selection.main.head === view.state.doc.length,
      'Clicking the bottom area must lock the caret to the document end'
    )
    await act(async () => {
      afterLanguageInput.focus()
      afterLanguageInput.dispatch({ selection: { anchor: afterLanguageInput.state.doc.length } })
      afterLanguageInput.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    })
    check(view.hasFocus, 'ArrowDown at the end of code must focus the paragraph below')
    const paragraph = view.state.selection.main.head
    await act(async () => view.dispatch({ changes: { from: paragraph, insert: 'after' } }))
    check(draft === '```r\nx <- 1\n```\n\n\nafter', 'Text after code must remain outside the fence')

    await setSource(view, '/ta')
    await press(view, 'Enter', { shiftKey: true })
    check(advances === 1, 'Shift+Enter must retain the Notebook advance shortcut')
    check(!view.hasFocus, 'Advancing must release focus from the previous Markdown cell')

    await setSource(view, '```\n\n```\n\n\n')
    const previousCodeView = codeInputView(host)
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
    check(
      codeInputView(host) === previousCodeView,
      'Language and theme must retain the code editor'
    )
    check(
      codeInputView(host).contentDOM.getAttribute('aria-label')?.includes('代码'),
      'The code editor label must follow the selected interface language'
    )
    const longDocument = Array.from({ length: 80 }, (_, index) => `$$\nE_${index} = mc^2\n$$`).join(
      '\n\n'
    )
    await setSource(view, longDocument)
    const mountedFormulas = host.querySelectorAll('[data-phi-notebook-formula-block]').length
    if (mountedFormulas > 24)
      regressions.push(`Long Markdown eagerly mounts ${mountedFormulas} formula renderers`)
    check(regressions.length === 0, regressions.join('; '))
    return {
      liveRendering: true,
      toolbar: true,
      slashMenu: true,
      draftRetained: true,
      mountedFormulas
    }
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
