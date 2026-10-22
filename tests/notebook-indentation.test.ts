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

test('notebook indentation inserts a Tab after Python blocks', () => {
  assert.equal(notebookCodeIndentUnit, '\t')
  assert.equal(
    EditorState.create({ extensions: notebookIndentationExtensions(() => 'python') }).tabSize,
    4
  )
  assert.equal(applyEnter('if value:', 'python'), 'if value:\n\t')
})

test('notebook indentation keeps current indentation without a new block', () => {
  assert.equal(applyEnter('\tvalue = call()', 'python'), '\tvalue = call()\n\t')
})

test('notebook indentation ignores block markers inside strings', () => {
  assert.equal(applyEnter('print("(")', 'python'), 'print("(")\n')
})

test('notebook indentation inserts a Tab after R and JavaScript blocks', () => {
  assert.equal(applyEnter('if (ready) {', 'r'), 'if (ready) {\n\t')
  assert.equal(applyEnter('function run() {', 'typescript'), 'function run() {\n\t')
})

test('notebook indentation handles shell block openers', () => {
  assert.equal(applyEnter('if true; then', 'shell'), 'if true; then\n\t')
})

test('notebook indentation reindents closing and dedent lines', () => {
  const state = EditorState.create({
    doc: ['if value:', '\thandle()', 'else:'].join('\n'),
    extensions: notebookIndentationExtensions(() => 'python')
  })

  assert.equal(getIndentation(state, state.doc.line(3).from), 0)
})

test('notebook indentation uses literal Tab and Shift-Tab units', () => {
  assert.equal(applyIndentCommand('value = 1', indentMore), '\tvalue = 1')
  assert.equal(applyIndentCommand('\tvalue = 1', indentLess), 'value = 1')
})

test('notebook indentation keeps a Tab for code without a language-specific rule', () => {
  assert.equal(applyEnter('\tvalue = 1', 'plain'), '\tvalue = 1\n\t')
})
