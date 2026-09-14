import assert from 'node:assert/strict'
import test from 'node:test'
import { insertNewlineAndIndent, indentMore, indentLess } from '@codemirror/commands'
import { getIndentation } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import {
  notebookCodeIndentUnit,
  notebookIndentationExtensions
} from '../src/renderer/src/features/analysis/notebook/notebookIndentation'
import type { SyntaxLanguage } from '../src/renderer/src/lib/syntaxHighlight'

function applyEnter(source: string, language: SyntaxLanguage): string {
  const state = EditorState.create({
    doc: source,
    selection: EditorSelection.cursor(source.length),
    extensions: notebookIndentationExtensions(() => language)
  })
  let nextState = state
  const handled = insertNewlineAndIndent({
    state,
    dispatch: (transaction) => {
      nextState = transaction.state
    }
  })

  assert.equal(handled, true)
  return nextState.doc.toString()
}

function applyIndentCommand(
  source: string,
  command: typeof indentMore | typeof indentLess
): string {
  const state = EditorState.create({
    doc: source,
    selection: EditorSelection.cursor(source.length),
    extensions: notebookIndentationExtensions(() => 'python')
  })
  let nextState = state
  const handled = command({
    state,
    dispatch: (transaction) => {
      nextState = transaction.state
    }
  })

  assert.equal(handled, true)
  return nextState.doc.toString()
}

test('notebook indentation inserts four spaces after Python blocks', () => {
  assert.equal(notebookCodeIndentUnit, '    ')
  assert.equal(applyEnter('if value:', 'python'), 'if value:\n    ')
})

test('notebook indentation keeps current indentation without a new block', () => {
  assert.equal(applyEnter('    value = call()', 'python'), '    value = call()\n    ')
})

test('notebook indentation ignores block markers inside strings', () => {
  assert.equal(applyEnter('print("(")', 'python'), 'print("(")\n')
})

test('notebook indentation inserts four spaces after R and JavaScript blocks', () => {
  assert.equal(applyEnter('if (ready) {', 'r'), 'if (ready) {\n    ')
  assert.equal(applyEnter('function run() {', 'typescript'), 'function run() {\n    ')
})

test('notebook indentation handles shell block openers', () => {
  assert.equal(applyEnter('if true; then', 'shell'), 'if true; then\n    ')
})

test('notebook indentation reindents closing and dedent lines', () => {
  const state = EditorState.create({
    doc: ['if value:', '    handle()', 'else:'].join('\n'),
    extensions: notebookIndentationExtensions(() => 'python')
  })

  assert.equal(getIndentation(state, state.doc.line(3).from), 0)
})

test('notebook indentation uses four-space Tab and Shift-Tab units', () => {
  assert.equal(applyIndentCommand('value = 1', indentMore), '    value = 1')
  assert.equal(applyIndentCommand('    value = 1', indentLess), 'value = 1')
})
