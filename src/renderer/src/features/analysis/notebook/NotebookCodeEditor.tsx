import { useEffect, useMemo, useRef } from 'react'
import {
  autocompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  insertNewlineAndIndent
} from '@codemirror/commands'
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
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state'
import {
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
import type { AnalysisNotebookCompletionResult } from '../../../types'
import {
  localNotebookCompletionOptions,
  mergedNotebookCompletionOptions,
  notebookCompletionRange,
  type NotebookEditorCompletionOption
} from '../lib/notebookCompletions'
import { notebookIndentationExtensions } from './notebookIndentation'
import { notebookRLanguage } from './notebookRLanguage'
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
  completionProvider?: NotebookCompletionProvider
  onFormat?: (source: string, language: SyntaxLanguage) => void | Promise<void>
  initialSelection?: number
}

export type NotebookCompletionProvider = (request: {
  source: string
  language: SyntaxLanguage
  cursorPosition: number
}) => Promise<AnalysisNotebookCompletionResult | null>

function languageExtension(language: SyntaxLanguage): Extension {
  if (language === 'python') return python()
  if (language === 'r') return notebookRLanguage
  if (language === 'javascript') return javascript()
  if (language === 'typescript') return javascript({ typescript: true })
  if (language === 'shell') return StreamLanguage.define(shell)
  if (language === 'markdown') return markdown()
  return []
}

function notebookEditorCaretColor(theme: Theme): string {
  return theme.palette.mode === 'dark' ? theme.palette.primary.light : theme.palette.text.primary
}

function completionTokenStart(
  source: string,
  cursorPosition: number,
  language: SyntaxLanguage
): number {
  const beforeCursor = source.slice(0, cursorPosition)
  if (beforeCursor.endsWith('.')) return cursorPosition
  const token =
    language === 'r'
      ? beforeCursor.match(/[A-Za-z.][A-Za-z0-9._]*$/)?.[0]
      : beforeCursor.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0]
  return token ? cursorPosition - token.length : cursorPosition
}

function completionShouldActivate(
  context: CompletionContext,
  source: string,
  tokenStart: number
): boolean {
  if (context.explicit) return true
  if (tokenStart < context.pos) return true
  return source.slice(Math.max(0, context.pos - 1), context.pos) === '.'
}

function codeMirrorCompletion(option: NotebookEditorCompletionOption): Completion {
  return {
    label: option.label,
    type: option.type,
    detail: option.detail
  }
}

export default function NotebookCodeEditor({
  value,
  language,
  onChange,
  onRun,
  onRequestClose,
  completionProvider,
  onFormat,
  initialSelection
}: NotebookCodeEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartmentRef = useRef(new Compartment())
  const initialValueRef = useRef(value)
  const initialLanguageRef = useRef(language)
  const initialSelectionRef = useRef(initialSelection)
  const languageRef = useRef(language)
  const onChangeRef = useRef(onChange)
  const onRunRef = useRef(onRun)
  const onRequestCloseRef = useRef(onRequestClose)
  const completionProviderRef = useRef(completionProvider)
  const onFormatRef = useRef(onFormat)
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

  useEffect(() => {
    completionProviderRef.current = completionProvider
  }, [completionProvider])

  useEffect(() => {
    onFormatRef.current = onFormat
  }, [onFormat])

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
        '.cm-content ::selection, .cm-content::selection': {
          backgroundColor: alpha(theme.palette.primary.main, 0.22)
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
        '&.cm-focused': {
          outline: 'none'
        }
      }),
    [caretColor, theme]
  )
  const highlightStyle = useMemo<HighlightStyle>(() => codeMirrorHighlightStyle(theme), [theme])
  const completionSource = useMemo(
    () =>
      async (context: CompletionContext): Promise<CompletionResult | null> => {
        const source = context.state.doc.toString()
        const currentLanguage = languageRef.current
        const tokenStart = completionTokenStart(source, context.pos, currentLanguage)
        if (!completionShouldActivate(context, source, tokenStart)) {
          return null
        }

        const local = localNotebookCompletionOptions({
          source,
          language: currentLanguage
        })
        let kernel: AnalysisNotebookCompletionResult | null = null
        try {
          kernel =
            (await completionProviderRef.current?.({
              source,
              language: currentLanguage,
              cursorPosition: context.pos
            })) ?? null
        } catch {
          kernel = null
        }
        const options = mergedNotebookCompletionOptions({ kernel, local })
        if (options.length === 0) return null
        return {
          ...notebookCompletionRange({
            kernel,
            tokenStart,
            cursorPosition: context.pos,
            sourceLength: source.length
          }),
          options: options.map(codeMirrorCompletion),
          validFor: currentLanguage === 'r' ? /^[A-Za-z0-9._]*$/ : /^[A-Za-z0-9_]*$/
        }
      },
    []
  )

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
      ...notebookIndentationExtensions(() => languageRef.current),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      syntaxHighlighting(highlightStyle, { fallback: true }),
      autocompletion({
        activateOnTyping: true,
        defaultKeymap: true,
        override: [completionSource]
      }),
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
        {
          key: 'Mod-Space',
          run: startCompletion
        },
        {
          key: 'Ctrl-Space',
          run: startCompletion
        },
        {
          key: 'Mod-Shift-f',
          run: (view) => {
            const format = onFormatRef.current
            if (!format) return false
            void format(view.state.doc.toString(), languageRef.current)
            return true
          }
        },
        {
          key: 'Enter',
          run: insertNewlineAndIndent
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
  }, [completionSource, editorTheme, highlightStyle])

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
    languageRef.current = language
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
      data-phi-notebook-completion={completionProvider ? 'kernel' : 'local'}
      data-phi-notebook-formatting={onFormat ? 'enabled' : 'disabled'}
      data-phi-syntax-language={language}
      sx={{ minHeight: notebookCodeMinHeight }}
    />
  )
}
