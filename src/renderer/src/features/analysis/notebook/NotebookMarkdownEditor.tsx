import { useUiLanguage } from '../../../lib/i18n'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Box } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state'
import { drawSelection, EditorView, keymap } from '@codemirror/view'
import MarkdownContent from '../../../components/MarkdownContent'
import {
  inlineMarkdownExtension,
  inlineMarkdownTheme,
  type MarkdownBlock
} from '../../../lib/markdown/inlineMarkdown'
import { analysisCopy } from '../lib/analysisUiCopy'
import { continueMarkdownOnEnter, moveToFencedCodeBody } from './markdownEnter'
import { fencedCodeAt, paragraphAfterFencedCode } from './markdownFencedCode'
import { displayMathAt, paragraphAfterDisplayMath } from './markdownDisplayMath'
import {
  insertMarkdown,
  markdownInsertLabel,
  markdownInsertSamples,
  type MarkdownInsertKind,
  type MarkdownInsertResult
} from './markdownInsert'
import {
  activeMarkdownSlash,
  filterMarkdownInsertKinds,
  insertFromMarkdownSlash,
  type MarkdownSlashMatch
} from './markdownSlash'
import { NotebookMarkdownSlashMenu } from './NotebookMarkdownSlashMenu'
import { NotebookMarkdownToolbar } from './NotebookMarkdownToolbar'
import { NotebookMarkdownCodeBlock } from './NotebookMarkdownCodeBlock'
import { NotebookMarkdownFormulaBlock } from './NotebookMarkdownFormulaBlock'
import { NotebookMarkdownInlineFormula } from './NotebookMarkdownInlineFormula'
import { inlineMathAt } from '../../../lib/markdown/markdownInlineMath'

type SlashState = { match: MarkdownSlashMatch; anchor: DOMRect }
type MarkdownWidget = { text: string; block: MarkdownBlock }
type EditorProps = {
  value: string
  onChange?: (value: string) => void
  onAdvance?: () => void
}

const externalChange = Annotation.define<boolean>()

function anchorAt(view: EditorView, position: number): DOMRect {
  const rect = view.coordsAtPos(position) ?? view.dom.getBoundingClientRect()
  return new DOMRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)
}

function applyResult(view: EditorView, result: MarkdownInsertResult): void {
  const source = view.state.doc.toString()
  view.dispatch({
    changes:
      source === result.value ? undefined : { from: 0, to: source.length, insert: result.value },
    selection: { anchor: result.selectionStart, head: result.selectionEnd },
    scrollIntoView: true
  })
  view.focus()
}

export function NotebookMarkdownEditor({
  value,
  onChange,
  onAdvance
}: EditorProps): React.JSX.Element {
  const uiLanguage = useUiLanguage()
  const theme = useTheme()
  const editable = Boolean(onChange)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const propsRef = useRef({ value, onChange, onAdvance })
  const slashRef = useRef<SlashState | null>(null)
  const activeIndexRef = useRef(0)
  const syncRef = useRef(() => {})
  const frameRef = useRef(0)
  const pendingCodeFocusRef = useRef<{
    position: number
    start: number
    end: number
  } | null>(null)
  const pendingFormulaFocusRef = useRef<{
    position: number
    start: number
    end: number
  } | null>(null)
  const compartments = useRef({ theme: new Compartment(), access: new Compartment() })
  const menuId = `phi-markdown-slash-${useId().replace(/:/g, '')}`
  const [selectionAnchor, setSelectionAnchor] = useState<DOMRect | null>(null)
  const [slash, setSlash] = useState<SlashState | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [formulaToFocus, setFormulaToFocus] = useState<number | null>(null)
  const [widgets, setWidgets] = useState<Map<HTMLElement, MarkdownWidget>>(() => new Map())
  const kinds = slash ? filterMarkdownInsertKinds(slash.match.query, markdownInsertLabel) : []
  const activeKind = kinds[activeIndex]

  const registerWidget = useCallback(
    (dom: HTMLElement, text: string, block: MarkdownBlock): void => {
      dom.dataset.phiMarkdownWidgetId ||= crypto.randomUUID()
      setWidgets((previous) => new Map(previous).set(dom, { text, block }))
    },
    []
  )
  const unregisterWidget = useCallback((dom: HTMLElement): void => {
    setWidgets((previous) => {
      const next = new Map(previous)
      next.delete(dom)
      return next
    })
  }, [])
  const inlineExtension = useMemo(
    () =>
      inlineMarkdownExtension(registerWidget, unregisterWidget, {
        keepFencedCodeRendered: true,
        keepDisplayMathRendered: true,
        keepSyntaxHidden: true,
        alwaysInlineBlocks: true
      }),
    [registerWidget, unregisterWidget]
  )
  const editorTheme = useMemo(
    () => [
      inlineMarkdownTheme,
      EditorView.theme(
        {
          '&.cm-editor': {
            minHeight: 48,
            color: theme.palette.text.primary,
            backgroundColor: 'transparent'
          },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': { overflow: 'visible' },
          '.cm-content': {
            minHeight: 48,
            padding: '13px 0',
            caretColor: theme.palette.primary.main
          },
          '.cm-line': { padding: '0 18px' },
          '.phi-inline-markdown-block': { padding: '0 18px' },
          '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
            { backgroundColor: alpha(theme.palette.primary.main, 0.2) },
          '.phi-inline-code, .phi-inline-fenced-line': {
            backgroundColor: alpha(theme.palette.primary.main, 0.055)
          },
          '.phi-inline-link': { color: theme.palette.primary.main }
        },
        { dark: theme.palette.mode === 'dark' }
      )
    ],
    [theme]
  )
  const initialTheme = useRef(editorTheme)

  useEffect(() => {
    propsRef.current = { value, onChange, onAdvance }
  })

  const setMenuIndex = useCallback((index: number): void => {
    activeIndexRef.current = index
    setActiveIndex(index)
  }, [])

  const clearMenus = useCallback((): void => {
    slashRef.current = null
    setSlash(null)
    setSelectionAnchor(null)
  }, [])

  const insertAtSelection = useCallback(
    (kind: MarkdownInsertKind): void => {
      const view = viewRef.current
      if (!view || !propsRef.current.onChange) return
      const selection = view.state.selection.main
      clearMenus()
      const result = insertMarkdown(
        view.state.doc.toString(),
        selection.from,
        selection.to,
        kind,
        markdownInsertSamples()
      )
      if (kind === 'codeBlock')
        pendingCodeFocusRef.current = { position: result.selectionStart, start: 0, end: 0 }
      if (
        kind === 'formula' &&
        result.value.slice(result.selectionStart - 3, result.selectionStart) === '$$\n'
      ) {
        pendingFormulaFocusRef.current = { position: result.selectionStart, start: 0, end: 0 }
        setFormulaToFocus(result.selectionStart)
      }
      applyResult(view, result)
    },
    [clearMenus]
  )

  const insertSlashChoice = useCallback(
    (kind: MarkdownInsertKind): void => {
      const view = viewRef.current
      if (!view || !propsRef.current.onChange) return
      const match = activeMarkdownSlash(view.state.doc.toString(), view.state.selection.main.head)
      if (!match) return
      clearMenus()
      const result = insertFromMarkdownSlash(
        view.state.doc.toString(),
        match,
        kind,
        markdownInsertSamples()
      )
      if (kind === 'codeBlock')
        pendingCodeFocusRef.current = { position: result.selectionStart, start: 0, end: 0 }
      if (
        kind === 'formula' &&
        result.value.slice(result.selectionStart - 3, result.selectionStart) === '$$\n'
      ) {
        pendingFormulaFocusRef.current = { position: result.selectionStart, start: 0, end: 0 }
        setFormulaToFocus(result.selectionStart)
      }
      applyResult(view, result)
    },
    [clearMenus]
  )

  const updateCodeBody = (
    start: number,
    body: string,
    selectionStart: number,
    selectionEnd: number
  ): void => {
    const view = viewRef.current
    if (!view || !propsRef.current.onChange) return
    const code = fencedCodeAt(view.state.doc.toString(), start)
    if (!code) return
    pendingCodeFocusRef.current = {
      position: code.bodyStart + selectionStart,
      start: selectionStart,
      end: selectionEnd
    }
    view.dispatch({ changes: { from: code.bodyStart, to: code.bodyEnd, insert: body } })
  }

  const updateCodeLanguage = (start: number, language: string): void => {
    const view = viewRef.current
    if (!view || !propsRef.current.onChange) return
    const code = fencedCodeAt(view.state.doc.toString(), start)
    if (!code) return
    pendingCodeFocusRef.current = {
      position: code.bodyStart,
      start: code.body.length,
      end: code.body.length
    }
    view.dispatch({
      changes: { from: code.languageStart, to: code.languageEnd, insert: language }
    })
  }

  const exitCodeBelow = (start: number): void => {
    const view = viewRef.current
    if (!view) return
    const result = paragraphAfterFencedCode(view.state.doc.toString(), start)
    if (!result) return
    applyResult(view, {
      value: result.value,
      selectionStart: result.cursor,
      selectionEnd: result.cursor
    })
  }

  const updateFormulaBody = (
    start: number,
    body: string,
    selectionStart: number,
    selectionEnd: number
  ): void => {
    const view = viewRef.current
    if (!view || !propsRef.current.onChange) return
    const math = displayMathAt(view.state.doc.toString(), start)
    if (!math) return
    pendingFormulaFocusRef.current = {
      position: math.bodyStart + selectionStart,
      start: selectionStart,
      end: selectionEnd
    }
    view.dispatch({ changes: { from: math.bodyStart, to: math.bodyEnd, insert: body } })
  }

  const exitFormulaBelow = (start: number): void => {
    const view = viewRef.current
    if (!view) return
    const result = paragraphAfterDisplayMath(view.state.doc.toString(), start)
    if (!result) return
    applyResult(view, {
      value: result.value,
      selectionStart: result.cursor,
      selectionEnd: result.cursor
    })
  }

  const updateInlineFormula = (start: number, body: string): void => {
    const view = viewRef.current
    if (!view || !propsRef.current.onChange) return
    const math = inlineMathAt(view.state.doc.toString(), start)
    if (math) view.dispatch({ changes: { from: math.bodyStart, to: math.bodyEnd, insert: body } })
  }

  useEffect(() => {
    if (!hostRef.current) return
    const initial = propsRef.current
    const { theme: appearance, access } = compartments.current
    const scheduleControls = (view: EditorView): void => {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(() => {
        if (viewRef.current !== view || !view.hasFocus) {
          clearMenus()
          return
        }
        const selection = view.state.selection.main
        if (!selection.empty) {
          slashRef.current = null
          setSlash(null)
          setSelectionAnchor(anchorAt(view, selection.to))
          return
        }
        setSelectionAnchor(null)
        const match = activeMarkdownSlash(view.state.doc.toString(), selection.head)
        const next = match ? { match, anchor: anchorAt(view, selection.head) } : null
        slashRef.current = next
        setSlash(next)
        setMenuIndex(0)
      })
    }
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initial.value.replace(/\r\n?/g, '\n'),
        extensions: [
          markdown({ base: markdownLanguage }),
          inlineExtension,
          EditorView.lineWrapping,
          drawSelection(),
          history(),
          keymap.of([
            {
              key: 'Enter',
              run: (editor) => {
                if (editor.compositionStarted) return false
                const open = slashRef.current
                if (open) {
                  const choices = filterMarkdownInsertKinds(open.match.query, markdownInsertLabel)
                  const choice = choices[activeIndexRef.current]
                  if (choice) {
                    insertSlashChoice(choice)
                    return true
                  }
                }
                const selection = editor.state.selection.main
                const source = editor.state.doc.toString()
                const result =
                  moveToFencedCodeBody(source, selection.from, selection.to) ??
                  continueMarkdownOnEnter(source, selection.from, selection.to)
                if (!result) return false
                applyResult(editor, result)
                return true
              }
            },
            {
              key: 'Shift-Enter',
              run: (editor) => {
                editor.contentDOM.blur()
                propsRef.current.onAdvance?.()
                return true
              }
            },
            {
              key: 'Mod-Enter',
              run: (editor) => {
                editor.contentDOM.blur()
                return true
              }
            },
            {
              key: 'Tab',
              run: () => {
                const open = slashRef.current
                const choice =
                  open &&
                  filterMarkdownInsertKinds(open.match.query, markdownInsertLabel)[
                    activeIndexRef.current
                  ]
                if (!choice) return false
                insertSlashChoice(choice)
                return true
              }
            },
            {
              key: 'Escape',
              run: () => {
                if (!slashRef.current) return false
                clearMenus()
                return true
              }
            },
            ...(['ArrowDown', 'ArrowUp'] as const).map((key) => ({
              key,
              run: () => {
                const open = slashRef.current
                if (!open) return false
                const choices = filterMarkdownInsertKinds(open.match.query, markdownInsertLabel)
                if (choices.length)
                  setMenuIndex(
                    (activeIndexRef.current + (key === 'ArrowDown' ? 1 : -1) + choices.length) %
                      choices.length
                  )
                return true
              }
            })),
            ...(['b', 'i', 'k'] as const).map((key) => ({
              key: `Mod-${key}`,
              run: () => {
                insertAtSelection(({ b: 'bold', i: 'italic', k: 'link' } as const)[key])
                return true
              }
            })),
            ...defaultKeymap,
            ...historyKeymap
          ]),
          appearance.of(initialTheme.current),
          access.of([
            EditorState.readOnly.of(!initial.onChange),
            EditorView.editable.of(Boolean(initial.onChange)),
            EditorView.contentAttributes.of({ 'aria-label': analysisCopy.markdownCellEditor })
          ]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((tr) => tr.annotation(externalChange))
            )
              propsRef.current.onChange?.(update.state.doc.toString())
            if (update.docChanged || update.selectionSet || update.focusChanged)
              scheduleControls(update.view)
          }),
          EditorView.domEventHandlers({
            focus: (_event, editor) => (scheduleControls(editor), false),
            blur: (_event, editor) => (scheduleControls(editor), false),
            compositionend: () => {
              requestAnimationFrame(() => syncRef.current())
              return false
            }
          })
        ]
      })
    })
    viewRef.current = view
    syncRef.current = () => {
      if (view.compositionStarted) return
      const current = propsRef.current.value.replace(/\r\n?/g, '\n')
      if (current === view.state.doc.toString()) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: current },
        annotations: [externalChange.of(true), Transaction.addToHistory.of(false)]
      })
    }
    return () => {
      cancelAnimationFrame(frameRef.current)
      syncRef.current = () => {}
      viewRef.current = null
      view.destroy()
    }
  }, [inlineExtension, clearMenus, insertAtSelection, insertSlashChoice, setMenuIndex])

  useEffect(() => syncRef.current(), [value])
  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.theme.reconfigure(editorTheme) })
  }, [editorTheme])
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.access.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
        EditorView.contentAttributes.of({
          'aria-label': analysisCopy.markdownCellEditor,
          ...(slash
            ? {
                'aria-controls': menuId,
                'aria-expanded': 'true',
                ...(activeKind ? { 'aria-activedescendant': `${menuId}-${activeKind}` } : {})
              }
            : {})
        })
      ])
    })
  }, [editable, uiLanguage, slash, activeKind, menuId])
  useEffect(() => {
    viewRef.current?.requestMeasure()
    const pending = pendingCodeFocusRef.current
    if (pending) {
      const target = Array.from(widgets).find(
        ([dom, widget]) =>
          dom.isConnected &&
          widget.block.name === 'FencedCode' &&
          widget.block.from <= pending.position &&
          pending.position <= widget.block.to
      )
      const input = target?.[0].querySelector<HTMLTextAreaElement>('[data-phi-notebook-code-input]')
      if (input) {
        pendingCodeFocusRef.current = null
        input.focus()
        input.setSelectionRange(pending.start, pending.end)
      }
    }
    const formulaFocus = pendingFormulaFocusRef.current
    if (!formulaFocus) return
    const formula = Array.from(widgets).find(
      ([dom, widget]) =>
        dom.isConnected &&
        widget.block.name === 'Math' &&
        widget.block.from <= formulaFocus.position &&
        formulaFocus.position <= widget.block.to
    )
    const formulaInput = formula?.[0].querySelector<HTMLTextAreaElement>(
      '[data-phi-notebook-formula-input]'
    )
    if (!formulaInput) return
    pendingFormulaFocusRef.current = null
    setFormulaToFocus(null)
    formulaInput.focus()
    formulaInput.setSelectionRange(formulaFocus.start, formulaFocus.end)
  }, [widgets])

  return (
    <Box data-phi-notebook-markdown-editor="live" sx={{ position: 'relative' }}>
      <Box ref={hostRef} data-phi-notebook-markdown-live="true" />
      {Array.from(widgets, ([dom, widget]) =>
        createPortal(
          widget.block.name === 'FencedCode' ? (
            <NotebookMarkdownCodeBlock
              source={widget.text}
              readOnly={!editable}
              onBodyChange={(body, start, end) =>
                updateCodeBody(widget.block.from, body, start, end)
              }
              onLanguageChange={(language) => updateCodeLanguage(widget.block.from, language)}
              onExitBelow={() => exitCodeBelow(widget.block.from)}
            />
          ) : widget.block.name === 'Math' ? (
            <NotebookMarkdownFormulaBlock
              source={widget.text}
              readOnly={!editable}
              startEditing={Boolean(
                formulaToFocus !== null &&
                widget.block.from <= formulaToFocus &&
                formulaToFocus <= widget.block.to
              )}
              onBodyChange={(body, start, end) =>
                updateFormulaBody(widget.block.from, body, start, end)
              }
              onExitBelow={() => exitFormulaBelow(widget.block.from)}
            />
          ) : widget.block.name === 'InlineMath' ? (
            <NotebookMarkdownInlineFormula
              source={widget.text}
              readOnly={!editable}
              onBodyChange={(body) => updateInlineFormula(widget.block.from, body)}
            />
          ) : (
            <MarkdownContent text={widget.text} enableMath />
          ),
          dom,
          dom.dataset.phiMarkdownWidgetId
        )
      )}
      <NotebookMarkdownToolbar anchor={selectionAnchor} onInsert={insertAtSelection} />
      <NotebookMarkdownSlashMenu
        anchor={slash?.anchor ?? null}
        menuId={menuId}
        kinds={kinds}
        activeIndex={activeIndex}
        onActiveIndexChange={setMenuIndex}
        onInsert={insertSlashChoice}
      />
    </Box>
  )
}
