import { useEffect, useMemo, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting
} from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { r } from '@codemirror/legacy-modes/mode/r'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state'
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { Box } from '@mui/material'
import { alpha, useTheme, type Theme } from '@mui/material/styles'
import type { SyntaxLanguage } from '../../../lib/syntaxHighlight'
import { codeMirrorHighlightStyle } from '../../../lib/syntaxTheme'
import {
  notebookCodeActionPaddingRight,
  notebookCodeContentPaddingBottom,
  notebookCodeContentPaddingTop,
  notebookCodeContentPaddingX,
  notebookCodeFontSizeRem,
  notebookCodeGutterDividerWidth,
  notebookCodeGutterPaddingRight,
  notebookCodeGutterWidth,
  notebookCodeLineHeight,
  notebookCodeMinHeight
} from './notebookCellLayout'

type NotebookCodeEditorProps = {
  value: string
  language: SyntaxLanguage
  onChange: (value: string) => void
  onRun?: () => void
  onRequestClose?: () => void
  initialSelection?: number
}

function languageExtension(language: SyntaxLanguage): Extension {
  if (language === 'python') return python()
  if (language === 'r') return StreamLanguage.define(r)
  if (language === 'javascript') return javascript()
  if (language === 'typescript') return javascript({ typescript: true })
  if (language === 'shell') return StreamLanguage.define(shell)
  if (language === 'markdown') return markdown()
  return []
}

function notebookEditorCaretColor(theme: Theme): string {
  return theme.palette.mode === 'dark' ? theme.palette.primary.light : theme.palette.text.primary
}

export default function NotebookCodeEditor({
  value,
  language,
  onChange,
  onRun,
  onRequestClose,
  initialSelection
}: NotebookCodeEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartmentRef = useRef(new Compartment())
  const initialValueRef = useRef(value)
  const initialLanguageRef = useRef(language)
  const initialSelectionRef = useRef(initialSelection)
  const onChangeRef = useRef(onChange)
  const onRunRef = useRef(onRun)
  const onRequestCloseRef = useRef(onRequestClose)
  const theme = useTheme()
  const caretColor = notebookEditorCaretColor(theme)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onRunRef.current = onRun
  }, [onRun])

  useEffect(() => {
    onRequestCloseRef.current = onRequestClose
  }, [onRequestClose])

  const editorTheme = useMemo(
    () =>
      EditorView.theme({
        '&': {
          boxSizing: 'border-box',
          minHeight: `${notebookCodeMinHeight}px`,
          color: theme.palette.text.primary,
          backgroundColor: 'transparent',
          fontFamily: 'var(--font-mono)',
          fontSize: `${notebookCodeFontSizeRem}rem`,
          lineHeight: String(notebookCodeLineHeight)
        },
        '.cm-scroller': {
          fontFamily: 'var(--font-mono)',
          fontSize: `${notebookCodeFontSizeRem}rem`,
          lineHeight: String(notebookCodeLineHeight),
          overflow: 'auto'
        },
        '.cm-content': {
          boxSizing: 'border-box',
          // Top/bottom padding matches NotebookCodeCellSource exactly; see
          // notebookCellLayout for why this has to be static padding rather
          // than flex/justify-content centering.
          padding: `${notebookCodeContentPaddingTop}px ${notebookCodeActionPaddingRight}px ${notebookCodeContentPaddingBottom}px ${notebookCodeContentPaddingX}px`,
          caretColor,
          minHeight: `${notebookCodeMinHeight}px`
        },
        '.cm-cursor, .cm-dropCursor': {
          borderLeftColor: `${caretColor} !important`,
          borderLeftWidth: '2px'
        },
        '.cm-line': {
          padding: 0,
          lineHeight: String(notebookCodeLineHeight)
        },
        '.cm-gutters': {
          boxSizing: 'border-box',
          position: 'relative',
          backgroundColor: 'transparent',
          color: theme.palette.text.disabled,
          borderRight: 0,
          width: `${notebookCodeGutterWidth}px`,
          minWidth: `${notebookCodeGutterWidth}px`,
          margin: 0,
          padding: 0,
          overflow: 'hidden'
        },
        '.cm-gutters::after': {
          content: '""',
          position: 'absolute',
          top: `${notebookCodeContentPaddingTop}px`,
          bottom: `${notebookCodeContentPaddingBottom}px`,
          right: 0,
          width: `${notebookCodeGutterDividerWidth}px`,
          backgroundColor: alpha(theme.palette.text.primary, 0.12),
          pointerEvents: 'none'
        },
        '.cm-gutter, .cm-lineNumbers': {
          boxSizing: 'border-box',
          flexShrink: 0,
          width: `${notebookCodeGutterWidth}px`,
          minWidth: `${notebookCodeGutterWidth}px`,
          margin: 0,
          padding: 0
        },
        '.cm-gutterElement, .cm-lineNumbers .cm-gutterElement, .cm-gutterElement.cm-activeLineGutter, .cm-lineNumbers .cm-gutterElement.cm-activeLineGutter':
          {
            boxSizing: 'border-box',
            width: `${notebookCodeGutterWidth}px`,
            minWidth: `${notebookCodeGutterWidth}px`,
            padding: `0 ${notebookCodeGutterPaddingRight}px 0 0`,
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
            lineHeight: String(notebookCodeLineHeight)
          },
        '.cm-gutterElement': {
          boxSizing: 'border-box',
          paddingLeft: 0
        },
        '.cm-activeLine': {
          backgroundColor: 'transparent'
        },
        '.cm-activeLineGutter': {
          boxSizing: 'border-box',
          backgroundColor: 'transparent',
          color: theme.palette.text.secondary,
          padding: `0 ${notebookCodeGutterPaddingRight}px 0 0`
        },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
          backgroundColor: `${alpha(theme.palette.primary.main, 0.22)} !important`
        },
        '.cm-selectionLayer .cm-selectionBackground:first-child': {
          marginLeft: `-${notebookCodeContentPaddingX}px`,
          paddingRight: `${notebookCodeContentPaddingX}px`
        },
        '&.cm-focused': {
          outline: 'none'
        }
      }),
    [caretColor, theme]
  )
  const highlightStyle = useMemo<HighlightStyle>(() => codeMirrorHighlightStyle(theme), [theme])

  useEffect(() => {
    if (!hostRef.current || viewRef.current) return undefined
    const initialDocument = initialValueRef.current
    const initialSelectionHead = Math.max(
      0,
      Math.min(initialSelectionRef.current ?? 0, initialDocument.length)
    )
    const baseExtensions = [
      lineNumbers(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      syntaxHighlighting(highlightStyle, { fallback: true }),
      keymap.of([
        {
          key: 'Escape',
          run: () => {
            onRequestCloseRef.current?.()
            return Boolean(onRequestCloseRef.current)
          }
        },
        {
          key: 'Shift-Enter',
          run: () => {
            onRunRef.current?.()
            return true
          }
        },
        {
          key: 'Mod-Enter',
          run: () => {
            onRunRef.current?.()
            return true
          }
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap
      ]),
      editorTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString())
      }),
      languageCompartmentRef.current.of(languageExtension(initialLanguageRef.current))
    ]
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialDocument,
        selection: EditorSelection.cursor(initialSelectionHead),
        extensions: baseExtensions
      })
    })
    viewRef.current = view
    view.focus()

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [editorTheme, highlightStyle])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const currentValue = view.state.doc.toString()
    if (currentValue === value) return
    view.dispatch({
      changes: { from: 0, to: currentValue.length, insert: value }
    })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: languageCompartmentRef.current.reconfigure(languageExtension(language))
    })
  }, [language])

  return (
    <Box
      ref={hostRef}
      data-phi-notebook-code-editor="codemirror"
      data-phi-notebook-code-theme="phi"
      data-phi-syntax-language={language}
      sx={{ minHeight: notebookCodeMinHeight }}
    />
  )
}
