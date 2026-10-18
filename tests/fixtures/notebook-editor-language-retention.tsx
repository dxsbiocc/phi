import { act, createElement, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createTheme, ThemeProvider } from '@mui/material'
import { enUS, zhCN } from '@mui/material/locale'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { undo, undoDepth } from '@codemirror/commands'
import NotebookCodeEditor from '../../src/renderer/src/features/analysis/notebook/NotebookCodeEditor'
import { setUiLanguage, type UiLanguage } from '../../src/renderer/src/lib/i18n'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const initialText = 'value = 1'
let draft = initialText
let changes = 0
let runs = 0
let currentRunCallback = (): void => {
  runs++
}

export function Harness({ theme }: { theme: ReturnType<typeof createTheme> }): React.JSX.Element {
  const [value, setValue] = useState(initialText)
  useEffect(() => {
    draft = value
  }, [value])
  return (
    <ThemeProvider theme={theme}>
      <NotebookCodeEditor
        value={value}
        language="python"
        onChange={(next) => {
          changes++
          setValue(next)
        }}
        onRun={currentRunCallback}
        initialSelection={2}
      />
    </ThemeProvider>
  )
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function run(): Promise<object> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const renderTheme = async (language: UiLanguage, mode: 'light' | 'dark'): Promise<void> => {
    await act(async () => {
      setUiLanguage(language)
      root.render(
        createElement(Harness, {
          theme: createTheme({ palette: { mode } }, language === 'zh-CN' ? zhCN : enUS)
        })
      )
    })
  }
  try {
    await renderTheme('en', 'light')
    const originalDom = host.querySelector<HTMLElement>('.cm-editor')
    check(originalDom, 'CodeMirror must mount in the real renderer')
    const view = EditorView.findFromDOM(originalDom)
    check(view, 'The mounted CodeMirror EditorView must be discoverable')
    const contentDom = view.contentDOM
    const originalColor = getComputedStyle(view.dom).color
    const unsavedText = `${initialText}\nunsaved_中文 = 2`
    await act(async () => {
      view.dispatch({
        changes: { from: initialText.length, insert: unsavedText.slice(initialText.length) },
        selection: EditorSelection.single(3, 8),
        userEvent: 'input.type'
      })
    })
    check(draft === unsavedText, 'Controlled draft must include the unsaved edit')
    const historyDepth = undoDepth(view.state)
    check(historyDepth > 0, 'An undo entry must exist before switching language')
    const selection = view.state.selection.main
    const changesBeforeSwitch = changes
    const snapshots: object[] = []
    for (const [language, mode] of [
      ['zh-CN', 'light'],
      ['zh-CN', 'dark'],
      ['en', 'dark']
    ] as const) {
      currentRunCallback = () => {
        runs += 10
      }
      await renderTheme(language, mode)
      check(
        host.querySelector('.cm-editor') === originalDom,
        'Language/theme changes must preserve the editor DOM'
      )
      check(
        EditorView.findFromDOM(originalDom) === view,
        'Language/theme changes must preserve EditorView identity'
      )
      check(view.contentDOM === contentDom, 'Language/theme changes must preserve the editable DOM')
      check(
        view.state.doc.toString() === unsavedText && draft === unsavedText,
        'Language/theme changes must preserve the document and controlled draft'
      )
      check(
        view.state.selection.main.anchor === selection.anchor &&
          view.state.selection.main.head === selection.head,
        'Language/theme changes must preserve cursor and selection'
      )
      check(
        undoDepth(view.state) === historyDepth,
        'Language/theme changes must preserve undo history'
      )
      check(
        changes === changesBeforeSwitch,
        'Visual reconfiguration must not emit document changes'
      )
      check(
        view.state.phrase('Completions') === (language === 'zh-CN' ? '补全建议' : 'Completions'),
        'Completion phrases must follow the UI language'
      )
      if (mode === 'dark')
        check(
          getComputedStyle(view.dom).color !== originalColor,
          'Palette changes must update the mounted editor appearance'
        )
      snapshots.push({
        language,
        mode,
        sameView: true,
        selection: [selection.anchor, selection.head],
        historyDepth
      })
    }
    await act(async () => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    check(runs === 10, 'The preserved editor must use the latest onRun callback')
    await act(async () => {
      check(undo(view), 'Undo must remain available after language/theme changes')
    })
    check(
      view.state.doc.toString() === initialText && draft === initialText,
      'Undo must restore the original document and controlled draft'
    )
    return {
      snapshots,
      unsavedTextPreserved: true,
      undoRestoredOriginal: true,
      latestCallbackPreserved: true
    }
  } finally {
    await act(async () => root.unmount())
    host.remove()
    setUiLanguage('en')
  }
}

run().then(
  (result) => console.log('PHI_EDITOR_RETENTION_RESULT:' + JSON.stringify({ ok: true, result })),
  (error: unknown) =>
    console.log(
      'PHI_EDITOR_RETENTION_RESULT:' +
        JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) })
    )
)
