import { composerCodeRanges, type InlineComposerReference } from '../../../lib/composerReferences'
import type { AnalysisNotebookContextReference } from '../../../types'

function referenceKind(
  reference: AnalysisNotebookContextReference
): InlineComposerReference['kind'] {
  return reference.kind === 'variable' && reference.detail === 'module' ? 'module' : reference.kind
}

function mentionBoundary(text: string, from: number, to: number): boolean {
  const before = text.slice(0, from)
  const after = text.slice(to)
  if (/[\p{L}\p{N}\p{M}_./\\:@-]$/u.test(before)) return false
  if (/^[\p{L}\p{N}\p{M}_/\\:@-]/u.test(after)) return false
  // A trailing sentence period is allowed; a dotted binding or filename is not a prefix match.
  return !after.startsWith('.') || !/^[\p{L}\p{N}\p{M}_./\\-]/u.test(after.slice(1))
}

/** Keep the raw prompt intact; decorations only cover complete, known @ references. */
export function notebookPromptReferences(
  text: string,
  candidates: readonly AnalysisNotebookContextReference[]
): InlineComposerReference[] {
  const knownByName = new Map<string, AnalysisNotebookContextReference>()
  for (const candidate of candidates) {
    if (candidate.name && !/[\r\n]/u.test(candidate.name) && !knownByName.has(candidate.name)) {
      knownByName.set(candidate.name, candidate)
    }
  }
  const known = [...knownByName.values()].sort(
    (left, right) => right.name.length - left.name.length
  )
  const protectedRanges = composerCodeRanges(text)
  const references: InlineComposerReference[] = []
  let occupiedUntil = 0
  for (const match of text.matchAll(/@/gu)) {
    const from = match.index
    if (from < occupiedUntil) continue
    for (const candidate of known) {
      const token = `@${candidate.name}`
      const to = from + token.length
      if (
        !text.startsWith(token, from) ||
        !mentionBoundary(text, from, to) ||
        protectedRanges.some((range) => range.from < to && range.to > from)
      ) {
        continue
      }
      references.push({
        from,
        to,
        text: text.slice(from, to),
        kind: referenceKind(candidate),
        id: candidate.id,
        name: candidate.name
      })
      occupiedUntil = to
      break
    }
  }
  return references
}

/** Resolve current source tokens at submission time so removed chips leave no hidden context. */
export function notebookPromptContextReferences(
  text: string,
  candidates: readonly AnalysisNotebookContextReference[],
  refactorTargetCellId?: string | null
): AnalysisNotebookContextReference[] {
  const byId = new Map<string, AnalysisNotebookContextReference>()
  for (const candidate of candidates) {
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate)
  }
  const selected = new Set<string>()
  const references: AnalysisNotebookContextReference[] = []
  // Selected-cell refactoring still needs its target when no @ token was explicitly typed.
  const target = refactorTargetCellId
    ? candidates.find(
        (candidate) => candidate.kind === 'cell_output' && candidate.cellId === refactorTargetCellId
      )
    : undefined
  if (target) {
    selected.add(target.id)
    references.push(target)
  }
  for (const mention of notebookPromptReferences(text, candidates)) {
    const reference = mention.id ? byId.get(mention.id) : undefined
    if (reference && !selected.has(reference.id)) {
      selected.add(reference.id)
      references.push(reference)
    }
  }
  return references
}
