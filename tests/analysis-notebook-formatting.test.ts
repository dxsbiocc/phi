import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatNotebookCellSource,
  type NotebookFormatterRunner
} from '../src/main/agent/notebook/analysis-notebook-formatting'

test('formatNotebookCellSource prefers ruff for Python cells', () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const runner: NotebookFormatterRunner = (command, args) => {
    calls.push({ command, args })
    return {
      status: 0,
      stdout: 'x = 1\n',
      stderr: ''
    }
  }

  const result = formatNotebookCellSource(
    {
      projectCwd: '/project',
      source: 'x=1',
      language: 'python'
    },
    { runner }
  )

  assert.equal(result.formatter, 'ruff')
  assert.equal(result.source, 'x = 1\n')
  assert.equal(result.changed, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args.slice(0, 2), ['format', '--line-length'])
})

test('formatNotebookCellSource falls back to black when ruff is unavailable', () => {
  const calls: string[] = []
  const runner: NotebookFormatterRunner = (command) => {
    calls.push(command)
    if (command === 'ruff') {
      return {
        status: null,
        stdout: '',
        stderr: '',
        errorCode: 'ENOENT'
      }
    }
    return {
      status: 0,
      stdout: 'value = {"a": 1}\n',
      stderr: ''
    }
  }

  const result = formatNotebookCellSource(
    {
      projectCwd: '/project',
      source: 'value={ "a":1 }',
      language: 'python3'
    },
    { runner }
  )

  assert.deepEqual(calls, ['ruff', 'python'])
  assert.equal(result.formatter, 'black')
  assert.equal(result.source, 'value = {"a": 1}\n')
})

test('formatNotebookCellSource leaves unsupported languages unchanged', () => {
  const result = formatNotebookCellSource({
    projectCwd: '/project',
    source: 'x <- 1',
    language: 'r'
  })

  assert.equal(result.formatter, 'none')
  assert.equal(result.changed, false)
  assert.equal(result.source, 'x <- 1')
  assert.match(result.message ?? '', /Python/)
})
