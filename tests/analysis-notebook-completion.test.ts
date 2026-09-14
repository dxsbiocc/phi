import assert from 'node:assert/strict'
import test from 'node:test'
import {
  completeNotebookPythonStaticCompletion,
  mergeNotebookCompletionResults
} from '../src/main/agent/notebook/analysis-notebook-completion'

const packageProvider = (): Array<{
  name: string
  kind: 'module' | 'package'
  source: 'third-party' | 'environment'
}> => [
  { name: 'pandas', kind: 'package', source: 'third-party' },
  { name: 'polars', kind: 'package', source: 'third-party' },
  { name: 'pathlib', kind: 'module', source: 'environment' }
]

test('completeNotebookPythonStaticCompletion suggests installed packages in import statements', () => {
  const source = 'import pan'
  const result = completeNotebookPythonStaticCompletion(
    {
      projectCwd: '/projects/research',
      source,
      cursorPosition: source.length
    },
    { packageProvider }
  )

  assert.ok(result)
  assert.deepEqual(result.matches, ['pandas'])
  assert.equal(result.cursorStart, 'import '.length)
  assert.equal(result.cursorEnd, source.length)
  assert.equal(result.metadata.phiCompletionSource, 'python-package')
})

test('completeNotebookPythonStaticCompletion suggests common members for third-party aliases', () => {
  const source = 'import pandas as pd\npd.re'
  const result = completeNotebookPythonStaticCompletion(
    {
      projectCwd: '/projects/research',
      source,
      cursorPosition: source.length
    },
    { packageProvider }
  )

  assert.ok(result)
  assert.deepEqual(result.matches, ['read_csv', 'read_excel', 'read_json'])
  assert.equal(result.cursorStart, source.length - 2)
  assert.equal(result.cursorEnd, source.length)
  assert.equal(result.metadata.phiCompletionSource, 'python-package-member')
})

test('completeNotebookPythonStaticCompletion skips ordinary local variable contexts', () => {
  let packageProviderCalled = false
  const result = completeNotebookPythonStaticCompletion(
    {
      projectCwd: '/projects/research',
      source: 'data_frame',
      cursorPosition: 'data_frame'.length
    },
    {
      packageProvider: () => {
        packageProviderCalled = true
        return packageProvider()
      }
    }
  )

  assert.equal(result, null)
  assert.equal(packageProviderCalled, false)
})

test('mergeNotebookCompletionResults keeps kernel results first and appends static matches', () => {
  const result = mergeNotebookCompletionResults(
    {
      matches: ['read_csv'],
      cursorStart: 21,
      cursorEnd: 23,
      metadata: {},
      status: 'ok'
    },
    {
      matches: ['read_csv', 'read_json'],
      cursorStart: 21,
      cursorEnd: 23,
      metadata: { phiCompletionSource: 'python-package-member' },
      status: 'ok'
    }
  )

  assert.deepEqual(result.matches, ['read_csv', 'read_json'])
  assert.equal(result.metadata.phiCompletionSource, 'kernel+python-static')
})
