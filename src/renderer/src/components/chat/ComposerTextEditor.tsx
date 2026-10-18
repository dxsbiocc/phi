import { chatCopy } from '../../features/chat/lib/chatCopy'
import { useUiLanguage } from '../../lib/i18n'
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands'
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  Transaction
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder as editorPlaceholder,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { Box } from '@mui/material'
import { ThemeProvider, useTheme, type Theme } from '@mui/material/styles'
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject
} from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ComposerReferenceChip } from './ComposerReferenceChip'
import type { ChatResourceMention } from '../../lib/chatResourceMentions'
import {
  findInlineComposerReferences,
  type InlineComposerReference
} from '../../lib/composerReferences'

export type ComposerTextEditorHandle = {
  readonly value: string
  readonly selectionStart: number
  readonly selectionEnd: number
  focus: (options?: FocusOptions) => void
  setSelectionRange: (from: number, to: number) => void
  replaceRange: (from: number, to: number, text: string) => void
}

type ComposerTextEditorProps = {
  value: string
  resources: readonly ChatResourceMention[]
  resolveReferences?: (text: string) => InlineComposerReference[]
  disabled?: boolean
  ariaLabel?: string
  focusKey?: string
  autoFocus?: boolean
  onOpenWebUrl?: (url: string) => void
  placeholder?: string
  placeholderKind?: string
  onChange: (value: string, cursor: number) => void
  onCursorChange?: (cursor: number) => void
  onKeyDown?: (event: KeyboardEvent, handle: ComposerTextEditorHandle) => boolean
  inputRef: RefObject<ComposerTextEditorHandle | null>
}

type EditorConfiguration = Omit<ComposerTextEditorProps, 'inputRef'> & { theme: Theme }

const externalValue = Annotation.define<boolean>()
const refreshReferences = StateEffect.define<null>()
const widgetRoots = new WeakMap<HTMLElement, Root>()

function hasFilePayload(data: DataTransfer | null): boolean {
  return Boolean(
    data &&
    (Array.from(data.types).includes('Files') ||
      Array.from(data.items).some((item) => item.kind === 'file'))
  )
}

function ReferenceWidgetContent({
  reference,
  view,
  theme,
  disabled
}: {
  reference: InlineComposerReference
  view: EditorView
  theme: Theme
  disabled: boolean
}): React.JSX.Element {
  useUiLanguage()
  useLayoutEffect(() => {
    view.requestMeasure()
  }, [reference, view])
  return (
    <ThemeProvider theme={theme}>
      <ComposerReferenceChip
        reference={reference}
        disabled={disabled}
        onRemove={() => {
          if (view.state.readOnly) return
          if (view.state.sliceDoc(reference.from, reference.to) !== reference.text) return
          view.dispatch({
            changes: { from: reference.from, to: reference.to },
            selection: EditorSelection.cursor(reference.from),
            userEvent: 'delete'
          })
          view.focus()
        }}
      />
    </ThemeProvider>
  )
}

class ReferenceWidget extends WidgetType {
  constructor(
    readonly reference: InlineComposerReference,
    readonly theme: Theme,
    readonly disabled: boolean
  ) {
    super()
  }

  eq(other: ReferenceWidget): boolean {
    const left = this.reference
    const right = other.reference
    return (
      this.theme === other.theme &&
      this.disabled === other.disabled &&
      left.from === right.from &&
      left.to === right.to &&
      left.kind === right.kind &&
      left.text === right.text &&
      left.name === right.name &&
      left.icon?.key === right.icon?.key &&
      left.available === right.available &&
      left.onOpen === right.onOpen
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('span')
    dom.className = 'phi-composer-inline-reference'
    dom.dataset.phiInlineReference = this.reference.kind
    dom.contentEditable = 'false'
    const root = createRoot(dom)
    widgetRoots.set(dom, root)
    root.render(
      <ReferenceWidgetContent
        reference={this.reference}
        view={view}
        theme={this.theme}
        disabled={this.disabled}
      />
    )
    return dom
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const root = widgetRoots.get(dom)
    if (!root) return false
    dom.dataset.phiInlineReference = this.reference.kind
    root.render(
      <ReferenceWidgetContent
        reference={this.reference}
        view={view}
        theme={this.theme}
        disabled={this.disabled}
      />
    )
    return true
  }

  ignoreEvent(): boolean {
    return true
  }

  destroy(dom: HTMLElement): void {
    const root = widgetRoots.get(dom)
    widgetRoots.delete(dom)
    // Destruction may run during the outer React root's effects.
    if (root) queueMicrotask(() => root.unmount())
  }
}

function referenceDecorations(view: EditorView, config: EditorConfiguration): DecorationSet {
  const cursor = view.state.selection.main
  const text = view.state.doc.toString()
  const references = config.resolveReferences
    ? config.resolveReferences(text)
    : findInlineComposerReferences(text, config.resources, config.onOpenWebUrl)
  return Decoration.set(
    references
      .filter(
        (reference) =>
          !reference.text.includes('\n') &&
          !(
            reference.kind === 'web' &&
            view.hasFocus &&
            cursor.empty &&
            cursor.head >= reference.from &&
            cursor.head <= reference.to
          )
      )
      .map((reference) =>
        Decoration.replace({
          widget: new ReferenceWidget(reference, config.theme, Boolean(config.disabled))
        }).range(reference.from, reference.to)
      ),
    true
  )
}

/** Rich references decorate the source document; editing and submission keep its original text. */
export function ComposerTextEditor({
  inputRef,
  ...props
}: ComposerTextEditorProps): React.JSX.Element {
  useUiLanguage()
  const {
    value,
    resources,
    resolveReferences,
    disabled,
    ariaLabel,
    focusKey,
    autoFocus,
    onOpenWebUrl,
    placeholder,
    placeholderKind,
    onChange,
    onCursorChange,
    onKeyDown
  } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const theme = useTheme()
  const configuration = useRef<EditorConfiguration>({ ...props, theme })
  const appearance = useRef(new Compartment())
  const handle = useMemo<ComposerTextEditorHandle>(
    () => ({
      get value() {
        return viewRef.current?.state.doc.toString() ?? configuration.current.value
      },
      get selectionStart() {
        return viewRef.current?.state.selection.main.from ?? 0
      },
      get selectionEnd() {
        return viewRef.current?.state.selection.main.to ?? 0
      },
      focus(options) {
        viewRef.current?.contentDOM.focus(options)
        viewRef.current?.focus()
      },
      setSelectionRange(from, to) {
        const view = viewRef.current
        if (!view) return
        const length = view.state.doc.length
        view.dispatch({
          selection: EditorSelection.range(
            Math.max(0, Math.min(from, length)),
            Math.max(0, Math.min(to, length))
          ),
          scrollIntoView: true
        })
      },
      replaceRange(from, to, text) {
        const view = viewRef.current
        if (!view || view.state.readOnly) return
        const length = view.state.doc.length
        const start = Math.max(0, Math.min(from, to, length))
        const end = Math.max(start, Math.min(Math.max(from, to), length))
        view.dispatch({
          changes: { from: start, to: end, insert: text },
          selection: EditorSelection.cursor(start + text.length),
          scrollIntoView: true,
          userEvent: 'input'
        })
      }
    }),
    []
  )
  useImperativeHandle(inputRef, () => handle, [handle])

  const accessibleLabel = ariaLabel ?? chatCopy.messageInput
  const visualExtensions = useMemo(
    () => [
      editorPlaceholder(placeholder ?? ''),
      EditorView.editable.of(!disabled),
      EditorState.readOnly.of(Boolean(disabled)),
      EditorView.contentAttributes.of({
        'data-phi-focus': focusKey ?? 'chat-input',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': accessibleLabel,
        'aria-disabled': disabled ? 'true' : 'false',
        'data-phi-placeholder-kind': placeholderKind ?? 'default',
        spellcheck: 'true'
      }),
      EditorView.theme({
        '&': {
          color: theme.palette.text.primary,
          backgroundColor: 'transparent',
          fontFamily: theme.typography.fontFamily ?? 'sans-serif',
          fontSize: '0.95rem',
          lineHeight: '1.6',
          minHeight: '1.6em'
        },
        '&.cm-focused': { outline: 'none' },
        '.cm-scroller': {
          fontFamily: 'inherit',
          lineHeight: 'inherit',
          maxHeight: '13.5em',
          overflowY: 'auto',
          overflowX: 'hidden'
        },
        '.cm-content': { padding: '9px 9px 0 0', caretColor: theme.palette.text.primary },
        '.cm-line': { padding: '0' },
        '.cm-placeholder': { color: theme.palette.text.secondary },
        '.phi-composer-inline-reference': {
          display: 'inline-flex',
          maxWidth: '100%',
          verticalAlign: 'middle',
          margin: '0 2px'
        }
      })
    ],
    [placeholder, placeholderKind, disabled, accessibleLabel, focusKey, theme]
  )

  // Native editor events must see the callbacks from the latest React commit.
  useLayoutEffect(() => {
    configuration.current = {
      value,
      resources,
      resolveReferences,
      disabled,
      ariaLabel,
      focusKey,
      autoFocus,
      onOpenWebUrl,
      placeholder,
      placeholderKind,
      onChange,
      onCursorChange,
      onKeyDown,
      theme
    }
    const view = viewRef.current
    if (view)
      view.dispatch({
        effects: [appearance.current.reconfigure(visualExtensions), refreshReferences.of(null)]
      })
  }, [
    value,
    resources,
    resolveReferences,
    disabled,
    ariaLabel,
    focusKey,
    autoFocus,
    onOpenWebUrl,
    placeholder,
    placeholderKind,
    onChange,
    onCursorChange,
    onKeyDown,
    theme,
    visualExtensions
  ])

  useEffect(() => {
    if (!hostRef.current) return undefined
    const references = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet

        constructor(view: EditorView) {
          this.decorations = referenceDecorations(view, configuration.current)
        }

        update(update: ViewUpdate): void {
          if (update.view.compositionStarted) {
            this.decorations = this.decorations.map(update.changes)
          } else if (
            update.docChanged ||
            update.selectionSet ||
            update.focusChanged ||
            update.transactions.some((transaction) =>
              transaction.effects.some((effect) => effect.is(refreshReferences))
            )
          ) {
            this.decorations = referenceDecorations(update.view, configuration.current)
          }
        }
      },
      {
        decorations: (plugin) => plugin.decorations,
        provide: (plugin) =>
          EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none)
      }
    )
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: configuration.current.value,
        extensions: [
          history(),
          keymap.of([
            { key: 'Enter', run: insertNewline, shift: insertNewline },
            ...defaultKeymap,
            ...historyKeymap
          ]),
          EditorView.lineWrapping,
          references,
          appearance.current.of(visualExtensions),
          Prec.high(
            EditorView.domEventHandlers({
              keydown(event, view) {
                if (
                  event.isComposing ||
                  event.keyCode === 229 ||
                  view.composing ||
                  view.state.readOnly ||
                  view.compositionStarted ||
                  (event.target instanceof Element &&
                    event.target.closest('[data-phi-inline-reference]'))
                )
                  return false
                return configuration.current.onKeyDown?.(event, handle) ?? false
              },
              paste: (event) => hasFilePayload(event.clipboardData),
              drop: (event) => hasFilePayload(event.dataTransfer),
              compositionend(_event, current) {
                queueMicrotask(() => {
                  if (viewRef.current === current)
                    current.dispatch({ effects: refreshReferences.of(null) })
                })
                return false
              }
            })
          ),
          EditorView.updateListener.of((update) => {
            const external = update.transactions.some((transaction) =>
              transaction.annotation(externalValue)
            )
            if (external) return
            const cursor = update.state.selection.main.head
            if (update.docChanged)
              configuration.current.onChange(update.state.doc.toString(), cursor)
            if (update.selectionSet || update.docChanged)
              configuration.current.onCursorChange?.(cursor)
          })
        ]
      })
    })
    viewRef.current = view
    if (configuration.current.autoFocus && !configuration.current.disabled) {
      view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) })
      view.focus()
    }
    return () => {
      viewRef.current = null
      view.destroy()
    }
    // Configuration and theme updates reconfigure the persistent view above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    const before = view.state.doc.toString()
    const after = value
    if (before === after) return
    let from = 0
    let suffix = 0
    while (from < before.length && from < after.length && before[from] === after[from]) from++
    while (
      suffix < before.length - from &&
      suffix < after.length - from &&
      before[before.length - suffix - 1] === after[after.length - suffix - 1]
    )
      suffix++
    view.dispatch({
      changes: {
        from,
        to: before.length - suffix,
        insert: after.slice(from, after.length - suffix)
      },
      annotations: [externalValue.of(true), Transaction.addToHistory.of(false)]
    })
  }, [value])

  return (
    <Box
      ref={hostRef}
      data-phi-composer-editor="codemirror"
      data-phi-placeholder-kind={placeholderKind ?? 'default'}
      sx={{ width: '100%', minWidth: 0, cursor: 'text' }}
    />
  )
}
