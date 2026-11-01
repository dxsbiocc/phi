import { ensureSyntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

/**
 * A new state parses for at most 20 ms, and decorations read that tree, so a loaded host renders
 * part of a document as plain text. The editor catches up in the background; a test has to ask.
 */
export function fullyParsed(state: EditorState): EditorState {
  if (!ensureSyntaxTree(state, state.doc.length, 10_000)) {
    throw new Error('The Markdown document did not finish parsing')
  }
  return state.update({}).state
}
