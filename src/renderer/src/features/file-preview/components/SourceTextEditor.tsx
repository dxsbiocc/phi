import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting
} from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { css } from '@codemirror/legacy-modes/mode/css'
import { json } from '@codemirror/legacy-modes/mode/javascript'
import { r } from '@codemirror/legacy-modes/mode/r'
import { rust } from '@codemirror/legacy-modes/mode/rust'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension
} from '@codemirror/state'
import {
  Decoration,
  drawSelection,
  EditorView,
  keymap,
  lineNumbers,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { Box } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { languageForPath } from '../../../lib/syntaxHighlight'
import { codeMirrorHighlightStyle } from '../../../lib/syntaxTheme'
import { inlineMarkdownExtension, inlineMarkdownTheme } from '../lib/inlineMarkdown'

export type SourceTextEditorProps = {
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  path: string
  query?: string
  caseSensitive?: boolean
  selection?: { from: number; to: number; requestId: number } | null
  ariaLabel?: string
  inlineMarkdown?: boolean
  renderMarkdown?: (content: string) => ReactNode
}

const externalChange = Annotation.define<boolean>()
const normalizedDocument = (value: string): string => value.replace(/\r\n?/g, '\n')
// The parent handles file search/save and dismissing search, including Ctrl+F on macOS.
const sourceKeymap = defaultKeymap.filter(
  (binding) => binding.key !== 'Escape' && binding.mac !== 'Ctrl-f'
)

function sourceLanguage(path: string): Extension {
  const language = languageForPath(path)
  if (language === 'javascript' || language === 'typescript') {
    return javascript({ typescript: language === 'typescript', jsx: /\.[jt]sx$/i.test(path) })
  }
  if (language === 'python') return python()
  if (language === 'markdown') return markdown({ base: markdownLanguage })
  const modes = { css, json, r, rust, shell, toml, yaml }
  return language in modes ? StreamLanguage.define(modes[language as keyof typeof modes]) : []
}

function searchHighlights(query: string, caseSensitive: boolean): Extension {
  if (!query || query.includes('\n')) return []
  const matcher = new MatchDecorator({
    regexp: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu'),
    decoration: (match, view, from) =>
      Decoration.mark({
        class:
          view.state.selection.main.from === from &&
          view.state.selection.main.to === from + match[0].length
            ? 'phi-source-search-current'
            : 'phi-source-search-match'
      })
  })
  return ViewPlugin.fromClass(
    class {
      decorations
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }
      update(update: ViewUpdate): void {
        this.decorations = update.selectionSet
          ? matcher.createDeco(update.view)
          : matcher.updateDeco(update, this.decorations)
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}

export function SourceTextEditor(props: SourceTextEditorProps): React.JSX.Element {
  const {
    onChange,
    readOnly = false,
    path,
    query = '',
    caseSensitive = false,
    ariaLabel = '文本内容',
    inlineMarkdown = false,
    renderMarkdown
  } = props
  const editable = Boolean(onChange && !readOnly)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const propsRef = useRef(props)
  const syncRef = useRef(() => {})
  const compartments = useRef({
    theme: new Compartment(),
    language: new Compartment(),
    access: new Compartment(),
    search: new Compartment(),
    presentation: new Compartment()
  })
  const [widgets, setWidgets] = useState<Map<HTMLElement, string>>(() => new Map())
  const registerWidget = useCallback((dom: HTMLElement, text: string): void => {
    dom.dataset.phiMarkdownWidgetId = crypto.randomUUID()
    setWidgets((previous) => new Map(previous).set(dom, text))
  }, [])
  const unregisterWidget = useCallback((dom: HTMLElement): void => {
    setWidgets((previous) => {
      const next = new Map(previous)
      next.delete(dom)
      return next
    })
  }, [])
  const inlineExtension = useMemo(
    () => inlineMarkdownExtension(registerWidget, unregisterWidget),
    [registerWidget, unregisterWidget]
  )
  const theme = useTheme()
  const editorTheme = useMemo(
    () => [
      syntaxHighlighting(codeMirrorHighlightStyle(theme), { fallback: true }),
      ...(inlineMarkdown ? [inlineMarkdownTheme] : []),
      EditorView.theme(
        {
          '&': {
            height: '100%',
            color: theme.palette.text.primary,
            backgroundColor: 'transparent',
            fontSize: '0.8125rem'
          },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '1.7' },
          '.cm-content': { padding: '12px 0', caretColor: theme.palette.text.primary },
          '.cm-line': { padding: '0 16px' },
          '.cm-gutters': {
            backgroundColor: 'transparent',
            color: theme.palette.text.disabled,
            border: 'none'
          },
          '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '36px' },
          '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
            { backgroundColor: alpha(theme.palette.primary.main, 0.2) },
          '.phi-source-search-match': { backgroundColor: alpha(theme.palette.warning.main, 0.25) },
          '.phi-source-search-current': {
            backgroundColor: alpha(theme.palette.warning.main, 0.5),
            outline: `1px solid ${theme.palette.warning.main}`
          },
          '&.cm-editor .phi-inline-heading-1': {
            fontSize: theme.typography.h6.fontSize ?? '1.25rem',
            lineHeight: String(theme.typography.h6.lineHeight ?? 1.4)
          },
          '&.cm-editor .phi-inline-heading-2': {
            fontSize: theme.typography.subtitle1.fontSize ?? '1rem',
            lineHeight: String(theme.typography.subtitle1.lineHeight ?? 1.5)
          },
          '&.cm-editor .phi-inline-heading-3': {
            fontSize: theme.typography.subtitle2.fontSize ?? '0.875rem',
            lineHeight: String(theme.typography.subtitle2.lineHeight ?? 1.57)
          },
          '&.cm-editor .phi-inline-code': {
            backgroundColor: alpha(theme.palette.primary.main, 0.06),
            color: theme.palette.text.primary
          },
          '&.cm-editor .phi-inline-link': {
            color: theme.palette.primary.main
          },
          '&.cm-editor .phi-inline-quote-line': {
            color: theme.palette.text.secondary
          },
          '&.cm-editor .phi-inline-fenced-line, &.cm-editor .cm-line:has(.phi-inline-fenced-text)':
            {
              backgroundColor: alpha(theme.palette.primary.main, 0.04),
              fontSize: '0.85rem'
            }
        },
        { dark: theme.palette.mode === 'dark' }
      )
    ],
    [theme, inlineMarkdown]
  )
  const initialTheme = useRef(editorTheme)

  useEffect(() => {
    propsRef.current = props
  })

  useEffect(() => {
    if (!hostRef.current) return
    const initial = propsRef.current
    const editable = Boolean(initial.onChange && !initial.readOnly)
    const { theme: appearance, language, access, search, presentation } = compartments.current
    let compositionFrame = 0
    let lastSelectionId: number | undefined
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: normalizedDocument(initial.value),
        extensions: [
          presentation.of(
            initial.inlineMarkdown ? [inlineExtension, EditorView.lineWrapping] : [lineNumbers()]
          ),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          keymap.of([indentWithTab, ...sourceKeymap, ...historyKeymap]),
          appearance.of(initialTheme.current),
          language.of(sourceLanguage(initial.path)),
          access.of([
            EditorState.readOnly.of(!editable),
            EditorView.editable.of(editable),
            EditorView.contentAttributes.of({
              'aria-label': initial.ariaLabel ?? '文本内容',
              tabindex: '0'
            })
          ]),
          search.of(searchHighlights(initial.query ?? '', initial.caseSensitive ?? false)),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((tr) => tr.annotation(externalChange))
            ) {
              const current = propsRef.current
              if (!current.readOnly) current.onChange?.(update.state.doc.toString())
            }
          }),
          EditorView.domEventHandlers({
            compositionend: () => {
              cancelAnimationFrame(compositionFrame)
              compositionFrame = requestAnimationFrame(() => syncRef.current())
              return false
            }
          })
        ]
      })
    })
    viewRef.current = view
    syncRef.current = () => {
      if (view.compositionStarted) return
      const current = propsRef.current
      const document = normalizedDocument(current.value)
      if (document !== view.state.doc.toString()) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: document },
          annotations: [externalChange.of(true), Transaction.addToHistory.of(false)]
        })
      }
      if (current.selection && current.selection.requestId !== lastSelectionId) {
        lastSelectionId = current.selection.requestId
        const from = Math.max(0, Math.min(current.selection.from, view.state.doc.length))
        const to = Math.max(from, Math.min(current.selection.to, view.state.doc.length))
        view.dispatch({
          selection: { anchor: from, head: to },
          effects: EditorView.scrollIntoView(from, { y: 'center' })
        })
      }
    }
    syncRef.current()
    return () => {
      cancelAnimationFrame(compositionFrame)
      syncRef.current = () => {}
      viewRef.current = null
      view.destroy()
    }
  }, [inlineExtension])

  useEffect(() => {
    syncRef.current()
  })
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.access.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel, tabindex: '0' })
      ])
    })
  }, [editable, ariaLabel])
  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.theme.reconfigure(editorTheme) })
  }, [editorTheme])
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.presentation.reconfigure(
        inlineMarkdown ? [inlineExtension, EditorView.lineWrapping] : [lineNumbers()]
      )
    })
  }, [inlineMarkdown, inlineExtension])
  useEffect(() => {
    viewRef.current?.requestMeasure()
  }, [widgets, renderMarkdown])
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.language.reconfigure(sourceLanguage(path))
    })
  }, [path])
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.search.reconfigure(searchHighlights(query, caseSensitive))
    })
  }, [query, caseSensitive])

  return (
    <>
      <Box
        ref={hostRef}
        data-phi-text-source-editor="codemirror"
        data-phi-text-readonly={!editable}
        data-phi-inline-markdown={inlineMarkdown || undefined}
        data-phi-syntax-language={languageForPath(path)}
        sx={{ flex: 1, minHeight: 0, minWidth: 0, height: '100%', overflow: 'hidden' }}
      />
      {renderMarkdown &&
        Array.from(widgets, ([dom, text]) =>
          createPortal(renderMarkdown(text), dom, dom.dataset.phiMarkdownWidgetId)
        )}
    </>
  )
}

export default SourceTextEditor
