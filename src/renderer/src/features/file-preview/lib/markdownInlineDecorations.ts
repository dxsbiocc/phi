import { syntaxTree } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration } from '@codemirror/view'

type SourceRange = { from: number; to: number }
type InlineFragment = SourceRange & { hidden: SourceRange[] }
type InlineMark = SourceRange & { className: string }
type MarkdownNode = ReturnType<typeof syntaxTree>['topNode']

const inlineClasses: Record<string, string> = {
  StrongEmphasis: 'phi-inline-strong',
  Emphasis: 'phi-inline-emphasis',
  Strikethrough: 'phi-inline-strike',
  InlineCode: 'phi-inline-code'
}

function childNodes(node: MarkdownNode): MarkdownNode[] {
  const children: MarkdownNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child)
  return children
}

function mergedRanges(ranges: SourceRange[]): SourceRange[] {
  const merged: SourceRange[] = []
  for (const range of ranges.sort((left, right) => left.from - right.from || left.to - right.to)) {
    const previous = merged.at(-1)
    if (previous && previous.to >= range.from) previous.to = Math.max(previous.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}

/** Keep presentation separate from the document so selection, copying and undo retain source. */
export function markdownInlinePresentation(
  state: EditorState,
  from: number,
  to: number,
  focused: boolean
): { hidden: SourceRange[]; marks: InlineMark[] } {
  const fragments: InlineFragment[] = []
  const marks: InlineMark[] = []
  syntaxTree(state).iterate({
    from,
    to,
    enter(ref) {
      // Images and structural code remain the block renderer's responsibility.
      if (/^(?:Image|FencedCode|CodeBlock|HTMLBlock|LinkReference)$/.test(ref.name)) return false
      if (ref.from < from || ref.to > to) return
      const children = childNodes(ref.node)
      const className = inlineClasses[ref.name]
      if (className) {
        const delimiters = children.filter((child) =>
          /^(?:EmphasisMark|StrikethroughMark|CodeMark)$/.test(child.name)
        )
        if (delimiters.length < 2) return
        fragments.push({
          from: ref.from,
          to: ref.to,
          hidden: delimiters.map((delimiter) => ({ from: delimiter.from, to: delimiter.to }))
        })
        const contentFrom = delimiters[0].to
        const contentTo = delimiters.at(-1)!.from
        if (contentFrom < contentTo) marks.push({ from: contentFrom, to: contentTo, className })
      } else if (ref.name === 'Link') {
        const opening = children.find((child) => child.name === 'LinkMark')
        const closing = children.find(
          (child) => child.name === 'LinkMark' && state.sliceDoc(child.from, child.to) === ']'
        )
        if (!opening || !closing) return
        const hidden: SourceRange[] = [{ from: opening.from, to: opening.to }]
        let tailFrom = closing.from
        for (const child of children.filter((child) => child.from >= closing.from)) {
          if (tailFrom < child.from) hidden.push({ from: tailFrom, to: child.from })
          hidden.push({ from: child.from, to: child.to })
          tailFrom = child.to
        }
        if (tailFrom < ref.to) hidden.push({ from: tailFrom, to: ref.to })
        fragments.push({ from: ref.from, to: ref.to, hidden })
        if (opening.to < closing.from)
          marks.push({ from: opening.to, to: closing.from, className: 'phi-inline-link' })
      }
      return undefined
    }
  })

  const active = new Set<InlineFragment>()
  if (focused) {
    for (const range of state.selection.ranges) {
      if (!range.empty) continue
      let nearest: InlineFragment | undefined
      for (const fragment of fragments) {
        if (
          fragment.from <= range.from &&
          fragment.to >= range.from &&
          (!nearest || fragment.to - fragment.from <= nearest.to - nearest.from)
        ) {
          nearest = fragment
        }
      }
      if (nearest) active.add(nearest)
    }
  }
  const hidden = fragments.flatMap((fragment) =>
    active.has(fragment)
      ? []
      : fragment.hidden.filter(
          (syntax) =>
            !state.selection.ranges.some(
              (range) => !range.empty && range.from < syntax.to && range.to > syntax.from
            )
        )
  )
  return { hidden: mergedRanges(hidden), marks }
}

export function markdownInlineDecorations(
  state: EditorState,
  from: number,
  to: number,
  focused: boolean
): Range<Decoration>[] {
  const { hidden, marks } = markdownInlinePresentation(state, from, to, focused)
  return [
    ...hidden.map((range) => Decoration.replace({ inclusive: false }).range(range.from, range.to)),
    ...marks.map((mark) => Decoration.mark({ class: mark.className }).range(mark.from, mark.to))
  ]
}
