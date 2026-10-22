import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
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

class MarkdownBlockWidget extends WidgetType {
  constructor(
    readonly block: MarkdownBlock,
    readonly source: string,
    readonly references: string,
    readonly register: RegisterWidget,
    readonly unregister: (dom: HTMLElement) => void,
    readonly inline = false,
    readonly stable = false
  ) {
    super()
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

export function inlineMarkdownExtension(
  register: RegisterWidget,
  unregister: (dom: HTMLElement) => void,
  options: {
    keepFencedCodeRendered?: boolean
    keepDisplayMathRendered?: boolean
    keepSyntaxHidden?: boolean
    alwaysInlineBlocks?: boolean
  } = {}
): Extension {
  const decorate = (state: EditorState, focused: boolean): DecorationSet => {
    const blocks = inlineMarkdownBlocks(state)
    const references = blocks
      .filter((block) => block.name === 'LinkReference')
      .map((block) => state.sliceDoc(block.from, block.to))
      .join('\n')
    const decorations = blocks.flatMap((block) => {
      const stableBlock = Boolean(
        (options.keepFencedCodeRendered && block.name === 'FencedCode') ||
        (options.keepDisplayMathRendered && block.name === 'Math')
      )
      const uneditableBlock =
        options.alwaysInlineBlocks &&
        /^(?:Table|CodeBlock|HTMLBlock|LinkReference)$/.test(block.name)
      if (
        stableBlock ||
        uneditableBlock ||
        (!options.alwaysInlineBlocks && !markdownBlockIsSelected(block, state, focused))
      ) {
        return [
          Decoration.replace({
            block: true,
            inclusive: true,
            widget: new MarkdownBlockWidget(
              block,
              state.sliceDoc(block.from, block.to),
              references,
              register,
              unregister,
              false,
              stableBlock
            )
          }).range(block.from, block.to)
        ]
      }
      let inline = [
        ...markdownInlineDecorations(
          state,
          block.from,
          block.to,
          focused,
          options.keepSyntaxHidden
        ),
        ...markdownBlockDecorations(state, block.from, block.to, focused, options.keepSyntaxHidden)
      ]
      const inlineWidgets: Array<{ from: number; to: number }> = []
      syntaxTree(state).iterate({
        from: block.from,
        to: block.to,
        enter(node) {
          if (node.name !== 'Image' && !(options.keepSyntaxHidden && node.name === 'Link')) return
          if (node.from < block.from || node.to > block.to) return false
          if (
            options.keepSyntaxHidden ||
            !markdownBlockIsSelected(
              { from: node.from, to: node.to, name: node.name },
              state,
              focused
            )
          ) {
            inlineWidgets.push({ from: node.from, to: node.to })
            inline.push(
              Decoration.replace({
                widget: new MarkdownBlockWidget(
                  { from: node.from, to: node.to, name: node.name },
                  state.sliceDoc(node.from, node.to),
                  references,
                  register,
                  unregister,
                  true,
                  options.keepSyntaxHidden
                )
              }).range(node.from, node.to)
            )
          }
          return false
        }
      })
      if (options.keepSyntaxHidden && options.alwaysInlineBlocks) {
        for (const math of inlineMathRanges(state.sliceDoc(block.from, block.to), block.from)) {
          if (inlineWidgets.some((widget) => math.from < widget.to && math.to > widget.from))
            continue
          inlineWidgets.push({ from: math.from, to: math.to })
          inline.push(
            Decoration.replace({
              widget: new MarkdownBlockWidget(
                { from: math.from, to: math.to, name: 'InlineMath' },
                state.sliceDoc(math.from, math.to),
                references,
                register,
                unregister,
                true,
                true
              )
            }).range(math.from, math.to)
          )
        }
      }
      if (inlineWidgets.length)
        inline = inline.filter(
          (range) =>
            inlineWidgets.some((widget) => range.from === widget.from && range.to === widget.to) ||
            !inlineWidgets.some((widget) => range.from < widget.to && range.to > widget.from)
        )
      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(block.name)
      if (!heading) return inline
      const line = state.doc.lineAt(block.from)
      const headingDecorations = [
        Decoration.line({ class: `phi-inline-heading phi-inline-heading-${heading[1]}` }).range(
          line.from
        )
      ]
      const prefix = /^ {0,3}#{1,6}[ \t]+/.exec(line.text)
      const syntaxSelected = (from: number, to: number): boolean =>
        state.selection.ranges.some((range) =>
          range.empty
            ? focused && range.from >= from && range.from < to
            : range.from < to && range.to > from
        )
      if (
        prefix &&
        (options.keepSyntaxHidden || !syntaxSelected(line.from, line.from + prefix[0].length))
      ) {
        headingDecorations.push(
          Decoration.replace({ inclusive: false }).range(line.from, line.from + prefix[0].length)
        )
      }
      if (block.name.startsWith('Setext')) {
        const node = syntaxTree(state)
          .topNode.getChildren(block.name)
          .find((node) => node.from === block.from)
        const marker = node?.getChild('HeaderMark')
        if (marker && (options.keepSyntaxHidden || !syntaxSelected(marker.from, marker.to))) {
          const underline = state.doc.lineAt(marker.from)
          headingDecorations.push(
            Decoration.replace({ block: true, inclusive: true }).range(
              underline.from,
              Math.min(state.doc.length, underline.to + 1)
            )
          )
        }
      }
      return [...headingDecorations, ...inline]
    })
    return Decoration.set(decorations, true)
  }
  const field = StateField.define({
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
  const queueEffect = (view: EditorView, effect: 'focus' | 'composition', value: boolean): void => {
    // Focus can fire during CodeMirror DOM reconciliation; dispatch after that update completes.
    queueMicrotask(() => {
      const current = view.state.field(field, false)
      if (!current || !view.dom.isConnected) return
      const next = effect === 'focus' ? view.hasFocus : value
      if ((effect === 'focus' ? current.focused : current.composing) === next) return
      view.dispatch({ effects: (effect === 'focus' ? focusEffect : compositionEffect).of(next) })
    })
  }
  return [
    field,
    markdownBlockTheme,
    EditorView.domEventHandlers({
      focus: (_event, view) => {
        queueEffect(view, 'focus', true)
        return false
      },
      blur: (_event, view) => {
        queueEffect(view, 'focus', false)
        return false
      },
      compositionstart: (_event, view) => {
        queueEffect(view, 'composition', true)
        return false
      },
      compositionend: (_event, view) => {
        queueEffect(view, 'composition', false)
        return false
      }
    })
  ]
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
