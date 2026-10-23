import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range as StateRange
} from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { markdownInlineDecorations } from './markdownInlineDecorations'
import { markdownBlockDecorations, markdownBlockTheme } from './markdownBlockDecorations'
import { inlineMathRanges } from './markdownInlineMath'

export type MarkdownBlock = { from: number; to: number; name: string }
type RegisterWidget = (dom: HTMLElement, text: string, block: MarkdownBlock) => void
const blocksByDocument = new WeakMap<
  EditorState['doc'],
  { tree: ReturnType<typeof syntaxTree>; blocks: MarkdownBlock[] }
>()

/** Use whole syntax blocks so lists, tables and fenced code retain their structure. */
export function inlineMarkdownBlocks(state: EditorState): MarkdownBlock[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 25) ?? syntaxTree(state)
  const cached = blocksByDocument.get(state.doc)
  if (cached?.tree === tree) return cached.blocks
  const blocks: MarkdownBlock[] = []
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.to > node.from) blocks.push({ from: node.from, to: node.to, name: node.name })
  }
  // The Markdown renderer understands display math, while the CommonMark tree splits
  // it at blank lines. Keep those source ranges together for the renderer.
  const math: MarkdownBlock[] = []
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number)
    const opening = /^ {0,3}(\${2,})[ \t]*$/.exec(line.text)
    if (
      !opening ||
      blocks.some(
        (block) =>
          /^(?:FencedCode|CodeBlock)$/.test(block.name) &&
          block.from <= line.from &&
          block.to > line.from
      )
    )
      continue
    const closing = new RegExp(`^ {0,3}[$]{${opening[1].length},}[ \t]*$`)
    let end: number | null = null
    while (++number <= state.doc.lines) {
      const candidate = state.doc.line(number)
      if (closing.test(candidate.text)) {
        end = candidate.to
        break
      }
    }
    if (end === null) break
    const range = {
      from: line.from,
      to: end,
      name: 'Math'
    }
    const previous = math.at(-1)
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to)
    else math.push(range)
  }
  const ordinary = blocks.flatMap((block) =>
    math.reduce<MarkdownBlock[]>(
      (segments, range) =>
        segments.flatMap((segment) => {
          if (range.from >= segment.to || range.to <= segment.from) return [segment]
          return [
            ...(segment.from < range.from ? [{ ...segment, to: range.from }] : []),
            ...(segment.to > range.to ? [{ ...segment, from: range.to }] : [])
          ]
        }),
      [block]
    )
  )
  const result = [...ordinary, ...math].sort((left, right) => left.from - right.from)
  blocksByDocument.set(state.doc, { tree, blocks: result })
  return result
}

export function markdownBlockIsSelected(
  block: MarkdownBlock,
  state: EditorState,
  focused: boolean
): boolean {
  return state.selection.ranges.some((range) =>
    range.empty
      ? focused && range.from >= block.from && range.from <= block.to
      : range.from < block.to && range.to > block.from
  )
}

/** Align visible characters with the original Markdown without serializing rendered HTML. */
export function markdownOffsetForVisibleText(source: string, prefix: string): number {
  let position = 0
  for (const character of prefix) {
    const found = source.indexOf(character, position)
    if (found >= 0) position = found + character.length
  }
  return position
}

function closestTextOffset(
  source: string,
  text: string,
  offset: number,
  approximate: number
): number {
  let closest = -1
  for (let at = source.indexOf(text); at >= 0; at = source.indexOf(text, at + 1)) {
    if (
      closest < 0 ||
      Math.abs(at + offset - approximate) < Math.abs(closest + offset - approximate)
    ) {
      closest = at
    }
  }
  return closest < 0 ? approximate : closest + offset
}

function clickedOffset(dom: HTMLElement, source: string, event: MouseEvent): number {
  const document = dom.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY)
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY)
  const node = caret?.offsetNode ?? range?.startContainer
  const offset = caret?.offset ?? range?.startOffset ?? 0
  if (!node || !dom.contains(node)) return 0
  const prefix = document.createRange()
  prefix.selectNodeContents(dom)
  prefix.setEnd(node, offset)
  const approximate = markdownOffsetForVisibleText(source, prefix.toString())
  // A text node usually maps exactly, including inside emphasis and fenced code.
  const text = node.nodeType === Node.TEXT_NODE ? node.textContent : null
  if (!text) return approximate
  return closestTextOffset(source, text, offset, approximate)
}

type MarkdownBlockWidgetOptions = {
  block: MarkdownBlock
  source: string
  references: string
  register: RegisterWidget
  unregister: (dom: HTMLElement) => void
  inline?: boolean
  stable?: boolean
}

class MarkdownBlockWidget extends WidgetType {
  readonly block: MarkdownBlock
  readonly source: string
  readonly references: string
  readonly register: RegisterWidget
  readonly unregister: (dom: HTMLElement) => void
  readonly inline: boolean
  readonly stable: boolean

  constructor(options: MarkdownBlockWidgetOptions) {
    super()
    this.block = options.block
    this.source = options.source
    this.references = options.references
    this.register = options.register
    this.unregister = options.unregister
    this.inline = options.inline ?? false
    this.stable = options.stable ?? false
  }

  eq(other: MarkdownBlockWidget): boolean {
    return (
      this.source === other.source &&
      this.references === other.references &&
      this.inline === other.inline &&
      this.stable === other.stable
    )
  }

  updateDOM(dom: HTMLElement, _view: EditorView, from: this): boolean {
    if (!this.stable || !from.stable || this.block.from !== from.block.from) return false
    dom.dataset.sourcePreview = this.source
    this.register(
      dom,
      this.references ? `${this.source}\n\n${this.references}` : this.source,
      this.block
    )
    return true
  }

  toDOM(view: EditorView): HTMLElement {
    const dom: HTMLElement = view.dom.ownerDocument.createElement(this.inline ? 'span' : 'div')
    dom.className = this.inline ? 'phi-inline-markdown-fragment' : 'phi-inline-markdown-block'
    dom.dataset.sourcePreview = this.source
    dom.addEventListener('mousedown', (event) => {
      if (
        event.button !== 0 ||
        view.state.readOnly ||
        (event.target instanceof Element &&
          (event.target.closest('button,input,textarea,select,[role="button"]') ||
            event.target.closest('[data-phi-notebook-code-input]') ||
            ((event.metaKey || event.ctrlKey) && event.target.closest('a'))))
      )
        return
      const offset = Math.min(this.source.length, clickedOffset(dom, this.source, event))
      const position = Math.min(view.state.doc.length, view.posAtDOM(dom, 0) + offset)
      event.preventDefault()
      view.dispatch({ selection: { anchor: position }, effects: focusEffect.of(true) })
      view.focus()
    })
    this.register(
      dom,
      this.references ? `${this.source}\n\n${this.references}` : this.source,
      this.block
    )
    return dom
  }

  destroy(dom: HTMLElement): void {
    this.unregister(dom)
  }
}

const focusEffect = StateEffect.define<boolean>()
const compositionEffect = StateEffect.define<boolean>()

type MarkdownDecorationOptions = {
  keepFencedCodeRendered?: boolean
  keepDisplayMathRendered?: boolean
  keepSyntaxHidden?: boolean
  alwaysInlineBlocks?: boolean
}

type MarkdownDecorationConfig = {
  register: RegisterWidget
  unregister: (dom: HTMLElement) => void
  options: MarkdownDecorationOptions
}

type MarkdownDecorationContext = MarkdownDecorationConfig & {
  state: EditorState
  focused: boolean
  references: string
}

type SourceRange = { from: number; to: number }

function blockWidget(
  context: MarkdownDecorationContext,
  block: MarkdownBlock,
  inline = false,
  stable = false
): MarkdownBlockWidget {
  return new MarkdownBlockWidget({
    block,
    source: context.state.sliceDoc(block.from, block.to),
    references: context.references,
    register: context.register,
    unregister: context.unregister,
    inline,
    stable
  })
}

function blockReplacement(
  context: MarkdownDecorationContext,
  block: MarkdownBlock,
  stable: boolean
): StateRange<Decoration> {
  return Decoration.replace({
    block: true,
    inclusive: true,
    widget: blockWidget(context, block, false, stable)
  }).range(block.from, block.to)
}

function addSyntaxWidgets(
  context: MarkdownDecorationContext,
  block: MarkdownBlock,
  decorations: StateRange<Decoration>[],
  widgets: SourceRange[]
): void {
  const { state, focused, options } = context
  syntaxTree(state).iterate({
    from: block.from,
    to: block.to,
    enter(node) {
      if (node.name !== 'Image' && !(options.keepSyntaxHidden && node.name === 'Link')) return
      if (node.from < block.from || node.to > block.to) return false
      const widgetBlock = { from: node.from, to: node.to, name: node.name }
      if (!options.keepSyntaxHidden && markdownBlockIsSelected(widgetBlock, state, focused))
        return false
      widgets.push(widgetBlock)
      decorations.push(
        Decoration.replace({
          widget: blockWidget(context, widgetBlock, true, Boolean(options.keepSyntaxHidden))
        }).range(node.from, node.to)
      )
      return false
    }
  })
}

function addInlineMathWidgets(
  context: MarkdownDecorationContext,
  block: MarkdownBlock,
  decorations: StateRange<Decoration>[],
  widgets: SourceRange[]
): void {
  if (!context.options.keepSyntaxHidden || !context.options.alwaysInlineBlocks) return
  const { state } = context
  for (const math of inlineMathRanges(state.sliceDoc(block.from, block.to), block.from)) {
    if (widgets.some((widget) => math.from < widget.to && math.to > widget.from)) continue
    widgets.push({ from: math.from, to: math.to })
    const mathBlock = { from: math.from, to: math.to, name: 'InlineMath' }
    decorations.push(
      Decoration.replace({ widget: blockWidget(context, mathBlock, true, true) }).range(
        math.from,
        math.to
      )
    )
  }
}

function removeCoveredDecorations(
  decorations: StateRange<Decoration>[],
  widgets: SourceRange[]
): StateRange<Decoration>[] {
  if (!widgets.length) return decorations
  return decorations.filter(
    (range) =>
      widgets.some((widget) => range.from === widget.from && range.to === widget.to) ||
      !widgets.some((widget) => range.from < widget.to && range.to > widget.from)
  )
}

function syntaxIsSelected(context: MarkdownDecorationContext, from: number, to: number): boolean {
  return context.state.selection.ranges.some((range) =>
    range.empty
      ? context.focused && range.from >= from && range.from < to
      : range.from < to && range.to > from
  )
}

function headingDecorations(
  context: MarkdownDecorationContext,
  block: MarkdownBlock
): StateRange<Decoration>[] {
  const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(block.name)
  if (!heading) return []
  const { state, options } = context
  const line = state.doc.lineAt(block.from)
  const decorations = [
    Decoration.line({ class: `phi-inline-heading phi-inline-heading-${heading[1]}` }).range(
      line.from
    )
  ]
  const prefix = /^ {0,3}#{1,6}[ \t]+/.exec(line.text)
  if (
    prefix &&
    (options.keepSyntaxHidden ||
      !syntaxIsSelected(context, line.from, line.from + prefix[0].length))
  ) {
    decorations.push(
      Decoration.replace({ inclusive: false }).range(line.from, line.from + prefix[0].length)
    )
  }
  if (!block.name.startsWith('Setext')) return decorations
  const node = syntaxTree(state)
    .topNode.getChildren(block.name)
    .find((candidate) => candidate.from === block.from)
  const marker = node?.getChild('HeaderMark')
  if (!marker || (!options.keepSyntaxHidden && syntaxIsSelected(context, marker.from, marker.to)))
    return decorations
  const underline = state.doc.lineAt(marker.from)
  decorations.push(
    Decoration.replace({ block: true, inclusive: true }).range(
      underline.from,
      Math.min(state.doc.length, underline.to + 1)
    )
  )
  return decorations
}

function inlineDecorationsForBlock(
  context: MarkdownDecorationContext,
  block: MarkdownBlock
): StateRange<Decoration>[] {
  const { state, focused, options } = context
  const decorations = [
    ...markdownInlineDecorations(state, block.from, block.to, focused, options.keepSyntaxHidden),
    ...markdownBlockDecorations(state, block.from, block.to, focused, options.keepSyntaxHidden)
  ]
  const widgets: SourceRange[] = []
  addSyntaxWidgets(context, block, decorations, widgets)
  addInlineMathWidgets(context, block, decorations, widgets)
  return [...headingDecorations(context, block), ...removeCoveredDecorations(decorations, widgets)]
}

function decorationsForBlock(
  context: MarkdownDecorationContext,
  block: MarkdownBlock
): StateRange<Decoration>[] {
  const { state, focused, options } = context
  const stable = Boolean(
    (options.keepFencedCodeRendered && block.name === 'FencedCode') ||
    (options.keepDisplayMathRendered && block.name === 'Math')
  )
  const uneditable =
    options.alwaysInlineBlocks && /^(?:Table|CodeBlock|HTMLBlock|LinkReference)$/.test(block.name)
  if (
    stable ||
    uneditable ||
    (!options.alwaysInlineBlocks && !markdownBlockIsSelected(block, state, focused))
  ) {
    return [blockReplacement(context, block, stable)]
  }
  return inlineDecorationsForBlock(context, block)
}

function markdownDecorations(
  state: EditorState,
  focused: boolean,
  config: MarkdownDecorationConfig
): DecorationSet {
  const blocks = inlineMarkdownBlocks(state)
  const references = blocks
    .filter((block) => block.name === 'LinkReference')
    .map((block) => state.sliceDoc(block.from, block.to))
    .join('\n')
  const context = { ...config, state, focused, references }
  return Decoration.set(
    blocks.flatMap((block) => decorationsForBlock(context, block)),
    true
  )
}

type InlineMarkdownFieldValue = {
  focused: boolean
  composing: boolean
  tree: ReturnType<typeof syntaxTree>
  decorations: DecorationSet
}

type DecorateMarkdown = (state: EditorState, focused: boolean) => DecorationSet

function createInlineMarkdownField(
  decorate: DecorateMarkdown
): StateField<InlineMarkdownFieldValue> {
  return StateField.define<InlineMarkdownFieldValue>({
    create: (state) => ({
      focused: false,
      composing: false,
      tree: syntaxTree(state),
      decorations: decorate(state, false)
    }),
    update: (value, transaction) => {
      let { focused, composing } = value
      for (const effect of transaction.effects) {
        if (effect.is(focusEffect)) focused = effect.value
        if (effect.is(compositionEffect)) composing = effect.value
      }
      if (composing) {
        return {
          ...value,
          focused,
          composing,
          decorations: value.decorations.map(transaction.changes)
        }
      }
      if (
        !transaction.docChanged &&
        !transaction.selection &&
        !transaction.reconfigured &&
        focused === value.focused &&
        composing === value.composing &&
        syntaxTree(transaction.state) === value.tree
      )
        return value
      return {
        focused,
        composing,
        decorations: decorate(transaction.state, focused),
        tree: syntaxTree(transaction.state)
      }
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
  })
}

function queueFieldEffect(
  view: EditorView,
  field: StateField<InlineMarkdownFieldValue>,
  effect: 'focus' | 'composition',
  value: boolean
): void {
  // Focus can fire during CodeMirror DOM reconciliation; dispatch after that update completes.
  queueMicrotask(() => {
    const current = view.state.field(field, false)
    if (!current || !view.dom.isConnected) return
    const next = effect === 'focus' ? view.hasFocus : value
    if ((effect === 'focus' ? current.focused : current.composing) === next) return
    view.dispatch({ effects: (effect === 'focus' ? focusEffect : compositionEffect).of(next) })
  })
}

function inlineMarkdownEventHandlers(field: StateField<InlineMarkdownFieldValue>): Extension {
  return EditorView.domEventHandlers({
    focus: (_event, view) => {
      queueFieldEffect(view, field, 'focus', true)
      return false
    },
    blur: (_event, view) => {
      queueFieldEffect(view, field, 'focus', false)
      return false
    },
    compositionstart: (_event, view) => {
      queueFieldEffect(view, field, 'composition', true)
      return false
    },
    compositionend: (_event, view) => {
      queueFieldEffect(view, field, 'composition', false)
      return false
    }
  })
}

export function inlineMarkdownExtension(
  register: RegisterWidget,
  unregister: (dom: HTMLElement) => void,
  options: MarkdownDecorationOptions = {}
): Extension {
  const config = { register, unregister, options }
  const field = createInlineMarkdownField((state, focused) =>
    markdownDecorations(state, focused, config)
  )
  return [field, markdownBlockTheme, inlineMarkdownEventHandlers(field)]
}

export const inlineMarkdownTheme = EditorView.theme({
  '&.cm-editor': { fontSize: '0.95rem' },
  '&.cm-editor .cm-scroller': { fontFamily: 'var(--font-stack, sans-serif)', lineHeight: '1.7' },
  '&.cm-editor .cm-content': { padding: '20px 0' },
  '&.cm-editor .cm-line': { padding: '0 24px' },
  '.phi-inline-markdown-block': {
    padding: '0 24px',
    cursor: 'text',
    overflow: 'hidden',
    whiteSpace: 'normal'
  },
  '.phi-inline-markdown-block:empty::before': {
    content: 'attr(data-source-preview)',
    whiteSpace: 'pre-wrap'
  },
  '.phi-inline-heading': { fontWeight: '700', lineHeight: '1.6' },
  '.phi-inline-heading-1': { fontSize: '1.25rem', lineHeight: '1.4' },
  '.phi-inline-heading-2': { fontSize: '1rem', lineHeight: '1.5' },
  '.phi-inline-heading-3': { fontSize: '0.875rem', lineHeight: '1.57' },
  '.phi-inline-heading-4': { fontSize: '1rem' },
  '.phi-inline-heading-5, .phi-inline-heading-6': { fontSize: '1em' },
  '.phi-inline-strong': { fontWeight: '700' },
  '.phi-inline-emphasis': { fontStyle: 'italic' },
  '.phi-inline-strike': { textDecoration: 'line-through' },
  '.phi-inline-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.9em',
    padding: '0.1em 0.3em',
    borderRadius: '4px'
  },
  '.phi-inline-link': { textDecoration: 'underline' },
  '.phi-inline-markdown-fragment [data-phi-markdown-rendered], .phi-inline-markdown-fragment [data-phi-markdown-rendered] > div, .phi-inline-markdown-fragment p':
    {
      display: 'inline',
      margin: '0 !important'
    }
})
