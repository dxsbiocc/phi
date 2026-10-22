import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension, Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'

type SourceRange = { from: number; to: number }
type MarkdownNode = ReturnType<typeof syntaxTree>['topNode']
type MarkerKind = 'list' | 'task' | 'quote'

function selected(
  state: EditorState,
  source: SourceRange,
  focused: boolean,
  caretTo = source.to
): boolean {
  return state.selection.ranges.some((range) =>
    range.empty
      ? focused && range.from >= source.from && range.from <= caretTo
      : range.from < source.to && range.to > source.from
  )
}

function listDepth(node: MarkdownNode): number {
  let depth = 0
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.name === 'BulletList' || parent.name === 'OrderedList') depth++
  return depth
}

function listLabel(marker: MarkdownNode, state: EditorState): string {
  const item = marker.parent
  const list = item?.parent
  if (list?.name !== 'OrderedList') return '•'
  let index = 0
  let start = 1
  for (let child = list.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'ListItem') continue
    if (index === 0 && child.firstChild?.name === 'ListMark') {
      const first = child.firstChild
      const parsed = Number.parseInt(state.sliceDoc(first.from, first.to), 10)
      if (Number.isFinite(parsed)) start = parsed
    }
    if (child.from === item?.from) return `${start + index}.`
    index++
  }
  return `${start}.`
}

class MarkdownMarkerWidget extends WidgetType {
  constructor(
    readonly kind: MarkerKind,
    readonly label: string
  ) {
    super()
  }

  eq(other: MarkdownMarkerWidget): boolean {
    return this.kind === other.kind && this.label === other.label
  }

  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument
    const dom = document.createElement('span')
    dom.className = `phi-inline-${this.kind}-marker`
    dom.setAttribute('aria-hidden', 'true')
    dom.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || view.state.readOnly) return
      event.preventDefault()
      const position = view.posAtDOM(dom, 0)
      view.dispatch({ selection: { anchor: position } })
      view.focus()
    })
    if (this.kind === 'task') {
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.disabled = true
      checkbox.checked = this.label.toLowerCase() === '[x]'
      dom.append(checkbox)
    } else dom.textContent = this.label
    return dom
  }
}

/** Render structural markers without replacing their containing list, quote or code body. */
export function markdownBlockDecorations(
  state: EditorState,
  from: number,
  to: number,
  focused: boolean
): Range<Decoration>[] {
  const decorations: Range<Decoration>[] = []
  const fences: SourceRange[] = []
  const lists = new Map<number, number>()
  const quotes = new Set<number>()
  const code = new Set<number>()
  syntaxTree(state).iterate({
    from,
    to,
    enter(ref) {
      if (/^(?:HTMLBlock|Table|InlineCode|Image)$/.test(ref.name)) return false
      if (ref.from < from || ref.to > to) return
      const node = ref.node
      const line = state.doc.lineAt(ref.from)
      let kind: MarkerKind | undefined
      let label = ''
      if (ref.name === 'ListMark') {
        kind = 'list'
        label = listLabel(node, state)
        lists.set(line.from, Math.max(lists.get(line.from) ?? 0, listDepth(node)))
        // Only remove source indentation; prefixes such as quote markers remain independent.
        const indentation = state.sliceDoc(line.from, node.from)
        if (indentation && !indentation.trim()) {
          const source = { from: line.from, to: node.from }
          if (!selected(state, source, focused))
            decorations.push(Decoration.replace({ inclusive: false }).range(source.from, source.to))
        }
      } else if (ref.name === 'TaskMarker') {
        kind = 'task'
        label = state.sliceDoc(ref.from, ref.to)
      } else if (ref.name === 'QuoteMark') {
        kind = 'quote'
        quotes.add(line.from)
      } else if (ref.name === 'FencedCode') {
        const delimiterLines = new Set<number>()
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name === 'CodeMark') delimiterLines.add(state.doc.lineAt(child.from).number)
          if (child.name === 'CodeText' && child.from < child.to)
            decorations.push(
              Decoration.mark({ class: 'phi-inline-fenced-text' }).range(child.from, child.to)
            )
        }
        for (const number of delimiterLines) {
          const fence = state.doc.line(number)
          const source = { from: fence.from, to: Math.min(state.doc.length, fence.to + 1) }
          if (!selected(state, source, focused, fence.to)) fences.push(source)
        }
        const last = state.doc.lineAt(node.to).number
        for (let number = line.number + 1; number <= last; number++)
          if (!delimiterLines.has(number)) code.add(state.doc.line(number).from)
      }
      if (kind && !selected(state, ref, focused))
        decorations.push(
          Decoration.replace({
            widget: new MarkdownMarkerWidget(kind, label),
            inclusive: false
          }).range(ref.from, ref.to)
        )
      return undefined
    }
  })

  for (const [position, depth] of lists)
    decorations.push(
      Decoration.line({
        class: 'phi-inline-list-line',
        attributes: { style: `padding-left: ${24 * depth}px` }
      }).range(position)
    )
  for (const position of quotes)
    decorations.push(Decoration.line({ class: 'phi-inline-quote-line' }).range(position))
  for (const position of code)
    decorations.push(Decoration.line({ class: 'phi-inline-fenced-line' }).range(position))
  return [
    ...decorations.filter(
      (range) => !fences.some((fence) => range.from < fence.to && range.to >= fence.from)
    ),
    ...fences.map((fence) =>
      Decoration.replace({ block: true, inclusive: true }).range(fence.from, fence.to)
    )
  ]
}

export const markdownBlockTheme: Extension = EditorView.theme({
  '.phi-inline-list-line': { marginBottom: '4px' },
  '.phi-inline-list-marker, .phi-inline-task-marker': {
    display: 'inline-block',
    width: '20px',
    textAlign: 'center'
  },
  '.phi-inline-task-marker input': {
    width: '13px',
    height: '13px',
    margin: '0 3px 0 4px',
    pointerEvents: 'none'
  },
  '.phi-inline-quote-marker': {
    display: 'inline-block',
    width: '14px',
    height: '1.2em',
    borderLeft: '2px solid currentColor',
    verticalAlign: 'middle'
  },
  '.phi-inline-fenced-line, .cm-line:has(.phi-inline-fenced-text)': {
    fontFamily: 'var(--font-mono, monospace)',
    lineHeight: '1.6'
  }
})
