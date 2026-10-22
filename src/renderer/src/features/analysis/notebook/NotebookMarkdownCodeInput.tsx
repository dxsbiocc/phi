import { useEffect, useMemo, useRef } from 'react'
import { Box } from '@mui/material'
import { useTheme, type Theme } from '@mui/material/styles'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  Annotation,
  Compartment,
  EditorState,
  RangeSetBuilder,
  type Extension
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { useUiLanguage } from '../../../lib/i18n'
import { highlightLine, type SyntaxLanguage } from '../../../lib/syntaxHighlight'
import { syntaxTokenColor } from '../../../lib/syntaxTheme'
import { analysisCopy } from '../lib/analysisUiCopy'

const externalChange = Annotation.define<boolean>()

function coloredCode(language: SyntaxLanguage, theme: Theme): Extension {
  const decorate = (state: EditorState): DecorationSet => {
    const marks = new RangeSetBuilder<Decoration>()
    for (let number = 1; number <= state.doc.lines; number++) {
      const line = state.doc.line(number)
      let position = line.from
      for (const token of highlightLine(line.text, language)) {
        const end = position + token.value.length
        if (token.kind !== 'plain' && end > position) {
          marks.add(
            position,
            end,
            Decoration.mark({
              attributes: {
                'data-phi-syntax-token': token.kind,
                style: `color: ${syntaxTokenColor(theme, token.kind)}`
              }
            })
          )
        }
        position = end
      }
    }
    return marks.finish()
  }
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = decorate(view.state)
      }
      update(update: ViewUpdate): void {
        if (update.docChanged) this.decorations = decorate(update.state)
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}

export function NotebookMarkdownCodeInput({
  value,
  language,
  readOnly,
  onChange,
  onExitBelow
}: {
  value: string
  language: SyntaxLanguage
  readOnly: boolean
  onChange: (value: string) => void
  onExitBelow: () => void
}): React.JSX.Element {
  const uiLanguage = useUiLanguage()
  const theme = useTheme()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const callbacksRef = useRef({ onChange, onExitBelow })
  const compartments = useRef({
    appearance: new Compartment(),
    access: new Compartment(),
    copy: new Compartment()
  })
  const appearance = useMemo<Extension>(
    () => [
      EditorView.theme(
        {
          '&': {
            backgroundColor: 'transparent',
            color: theme.palette.text.primary,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85rem'
          },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)' },
          '.cm-content': {
            boxSizing: 'border-box',
            minHeight: 70,
            padding: '31px 12px 10px',
            caretColor: theme.palette.text.primary
          },
          '.cm-line': { padding: 0, lineHeight: '1.65' },
          '.cm-placeholder': { color: theme.palette.text.disabled },
          '.cm-cursor': { borderLeftColor: theme.palette.text.primary },
          '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
            {
              backgroundColor: theme.palette.action.selected
            }
        },
        { dark: theme.palette.mode === 'dark' }
      ),
      coloredCode(language, theme)
    ],
    [language, theme]
  )
  const initial = useRef({ value, appearance, readOnly })

  useEffect(() => {
    callbacksRef.current = { onChange, onExitBelow }
  }, [onChange, onExitBelow])

  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initial.current.value,
        extensions: [
          history(),
          compartments.current.appearance.of(initial.current.appearance),
          compartments.current.access.of([
            EditorState.readOnly.of(initial.current.readOnly),
            EditorView.editable.of(!initial.current.readOnly)
          ]),
          compartments.current.copy.of([
            placeholder(analysisCopy.markdownCodePlaceholder),
            EditorView.contentAttributes.of({ 'aria-label': analysisCopy.markdownCodeInput })
          ]),
          keymap.of([
            {
              key: 'ArrowDown',
              run: (editor) => {
                if (editor.state.selection.main.head !== editor.state.doc.length) return false
                callbacksRef.current.onExitBelow()
                return true
              }
            },
            {
              key: 'Mod-Enter',
              run: () => {
                callbacksRef.current.onExitBelow()
                return true
              }
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap
          ]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) => transaction.annotation(externalChange))
            )
              callbacksRef.current.onChange(update.state.doc.toString())
          })
        ]
      })
    })
    viewRef.current = view
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: externalChange.of(true)
    })
  }, [value])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.appearance.reconfigure(appearance) })
  }, [appearance])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.access.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly)
      ])
    })
  }, [readOnly])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.copy.reconfigure([
        placeholder(analysisCopy.markdownCodePlaceholder),
        EditorView.contentAttributes.of({ 'aria-label': analysisCopy.markdownCodeInput })
      ])
    })
  }, [uiLanguage])

  return (
    <Box
      ref={hostRef}
      data-phi-notebook-code-input="true"
      data-phi-notebook-code-highlight="true"
    />
  )
}
