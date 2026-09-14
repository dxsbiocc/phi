import assert from 'node:assert/strict'
import test from 'node:test'
import { StringStream } from '@codemirror/language'
import { notebookRParser } from '../src/renderer/src/features/analysis/notebook/notebookRLanguage'

function rTokenStyles(line: string): Array<[string, string | null]> {
  const stream = new StringStream(line, 4, 2)
  const state = notebookRParser.startState?.(2) ?? {}
  const tokens: Array<[string, string | null]> = []

  while (!stream.eol()) {
    stream.start = stream.pos
    const style = notebookRParser.token(stream, state)
    tokens.push([stream.current(), style])
  }

  return tokens
}

test('notebook R parser highlights calls and member access like the read-only highlighter', () => {
  assert.deepEqual(rTokenStyles('mtcars$mpg'), [
    ['mtcars', 'variableName'],
    ['$', 'operator'],
    ['mpg', 'propertyName']
  ])

  assert.deepEqual(rTokenStyles('ggplot2::ggplot(mtcars)'), [
    ['ggplot2', 'variableName'],
    ['::', 'operator'],
    ['ggplot', 'propertyName.function'],
    ['(', 'punctuation'],
    ['mtcars', 'variableName'],
    [')', 'punctuation']
  ])

  assert.deepEqual(rTokenStyles('as.data.frame(mtcars)'), [
    ['as.data.frame', 'variableName.function'],
    ['(', 'punctuation'],
    ['mtcars', 'variableName'],
    [')', 'punctuation']
  ])
})
