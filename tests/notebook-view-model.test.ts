import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildNotebookAiContextOptions,
  contextReferenceForFilePath,
  documentCells,
  kernelAvailabilityLabel,
  notebookKernelName,
  notebookLanguage,
  notebookOutputDataKind,
  notebookOutline,
  plainMarkdownInlineText,
  withNotebookKernel
} from '../src/renderer/src/features/analysis/lib/notebookViewModel'
import { parseNotebook } from '../src/shared/notebookDocument'
import type { AnalysisKernelDiagnostics, AnalysisKernelSummary } from '../src/renderer/src/types'

const pythonKernel: AnalysisKernelSummary = {
  name: 'python3',
  displayName: 'Python 3',
  language: 'python',
  rawLanguage: 'python'
}

const rKernel: AnalysisKernelSummary = {
  name: 'ir',
  displayName: 'R',
  language: 'r',
  rawLanguage: 'R'
}

const diagnostics: AnalysisKernelDiagnostics = {
  jupyterServer: { available: true },
  kernels: [pythonKernel, rKernel],
  preferredKernelName: 'python3',
  hasPythonKernel: true,
  hasRKernel: true
}

test('notebook view model labels JavaScript output artifacts', () => {
  assert.equal(notebookOutputDataKind('application/javascript'), 'JavaScript')
  assert.equal(notebookOutputDataKind('text/javascript'), 'JavaScript')
})

test('notebook view model derives canvas cells and markdown outline', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python' }
    },
    cells: [
      {
        id: 'intro',
        cell_type: 'markdown',
        metadata: {},
        source: '# QC **Summary**\nBody\n## [Details](./details.md)'
      },
      {
        id: 'load',
        cell_type: 'code',
        metadata: { phi: { executionDurationMs: 1530 } },
        execution_count: 1,
        source: 'df = pd.read_csv("qc.csv")\ndf',
        outputs: [
          {
            output_type: 'display_data',
            data: {
              'text/html':
                '<table><thead><tr><th>sample</th><th>value</th></tr></thead><tbody><tr><td>S1</td><td>1</td></tr></tbody></table>'
            },
            metadata: {}
          }
        ]
      },
      {
        id: 'error',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        source: 'raise ValueError("bad")',
        outputs: [{ output_type: 'error', data: {}, metadata: {}, ename: 'ValueError' }]
      }
    ]
  })

  const cells = documentCells(document, 'load')

  assert.equal(cells[1].state, 'running')
  assert.equal(cells[1].language, 'python')
  assert.equal(cells[1].executionDurationMs, 1530)
  assert.equal(documentCells(document)[2].state, 'error')
  assert.deepEqual(
    notebookOutline(cells).map((item) => [item.level, item.title]),
    [
      [1, 'QC **Summary**'],
      [2, '[Details](./details.md)']
    ]
  )
  assert.deepEqual(
    notebookOutline(cells).map((item) => [item.level, plainMarkdownInlineText(item.title)]),
    [
      [1, 'QC Summary'],
      [2, 'Details']
    ]
  )
})

test('notebook view model extracts AI context references from cells and outputs', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python' }
    },
    cells: [
      {
        id: 'imports',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        source: 'import pandas as pd\nfrom scipy import stats',
        outputs: []
      },
      {
        id: 'load',
        cell_type: 'code',
        metadata: {},
        execution_count: 1,
        source: 'df = pd.read_json("use_data.json")\nthreshold = 0.05',
        outputs: [
          {
            output_type: 'stream',
            data: {},
            metadata: {},
            text: 'shape: (284, 3)\n'
          }
        ]
      }
    ]
  })

  const references = buildNotebookAiContextOptions(documentCells(document))

  assert.ok(references.some((reference) => reference.id === 'variable:pd'))
  assert.ok(references.some((reference) => reference.id === 'variable:stats'))
  assert.ok(references.some((reference) => reference.id === 'dataframe:df'))
  assert.ok(references.some((reference) => reference.id === 'cell_output:load'))
  assert.equal(
    references.find((reference) => reference.id === 'dataframe:df')?.preview?.shape,
    '284 rows, 3 columns'
  )
})

test('notebook view model extracts R dataframe and variable context references', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'ir', display_name: 'R', language: 'R' },
      language_info: { name: 'R' }
    },
    cells: [
      {
        id: 'load-r',
        cell_type: 'code',
        metadata: {},
        execution_count: 1,
        source:
          'counts <- readr::read_csv("counts.csv")\nmetadata <- tibble::tibble(sample = c("S1"))\nthreshold <- 0.05',
        outputs: []
      }
    ]
  })

  const references = buildNotebookAiContextOptions(documentCells(document))

  assert.ok(references.some((reference) => reference.id === 'dataframe:counts'))
  assert.ok(references.some((reference) => reference.id === 'dataframe:metadata'))
  assert.ok(references.some((reference) => reference.id === 'variable:threshold'))
  assert.ok(!references.some((reference) => reference.id === 'variable:counts'))
  assert.match(
    references.find((reference) => reference.id === 'dataframe:counts')?.preview?.source ?? '',
    /readr::read_csv/
  )
})

test('notebook view model updates kernel metadata without losing language info', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python', version: '3.10.18' }
    },
    cells: []
  })

  const updated = withNotebookKernel(document, rKernel)

  assert.equal(notebookKernelName(updated), 'ir')
  assert.equal(notebookLanguage(updated), 'R')
  assert.equal(updated.metadata.language_info?.['version'], '3.10.18')
  assert.equal(kernelAvailabilityLabel(updated, diagnostics, false, null), 'R · not started')
})

test('contextReferenceForFilePath builds a data_source reference from an absolute path', () => {
  const reference = contextReferenceForFilePath('/Users/dengxsh/projects/demo/data/patients.csv')

  assert.equal(reference.kind, 'data_source')
  assert.equal(reference.name, 'patients.csv')
  assert.equal(reference.detail, '/Users/dengxsh/projects/demo/data/patients.csv')
  assert.equal(reference.preview?.source, '/Users/dengxsh/projects/demo/data/patients.csv')
  assert.equal(reference.id, 'data_source:/Users/dengxsh/projects/demo/data/patients.csv')
})

test('contextReferenceForFilePath handles Windows-style paths too', () => {
  const reference = contextReferenceForFilePath('C:\\Users\\dengxsh\\demo\\data.csv')

  assert.equal(reference.name, 'data.csv')
})

test('contextReferenceForFilePath produces a stable id so picking the same file twice dedupes', () => {
  const first = contextReferenceForFilePath('/project/data.csv')
  const second = contextReferenceForFilePath('/project/data.csv')

  assert.equal(first.id, second.id)
})
