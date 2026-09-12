import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectBareFileReferencePaths,
  inlineCodeFilePath,
  localHrefToPath,
  localPathKindForReference,
  tokenizeBareFileReferences
} from '../src/renderer/src/lib/markdownLocalPathReferences'

const cwd = '/Users/example/project'

test('markdown local path references collect bare notebook candidates', () => {
  assert.deepEqual(collectBareFileReferencePaths('Open analysis.ipynb and README.md', cwd), [
    '/Users/example/project/analysis.ipynb',
    '/Users/example/project/notebooks/analysis.ipynb',
    '/Users/example/project/README.md'
  ])
})

test('markdown local path references tokenize only stat-confirmed bare files', () => {
  const knownPaths = new Map([
    ['/Users/example/project/README.md', 'file'],
    ['/Users/example/project/results', 'directory']
  ] as const)

  assert.deepEqual(tokenizeBareFileReferences('See README.md and results.', cwd, knownPaths), [
    { kind: 'text', text: 'See ' },
    {
      kind: 'path',
      text: 'README.md',
      absolutePath: '/Users/example/project/README.md',
      pathKind: 'file'
    },
    { kind: 'text', text: ' and results.' }
  ])
})

test('markdown local path references resolve link and inline code paths', () => {
  assert.equal(
    localHrefToPath('/Users/example/project/src/foo%23bar.ts#L4', cwd),
    '/Users/example/project/src/foo#bar.ts'
  )
  assert.equal(inlineCodeFilePath('./src/App.tsx:12', cwd), '/Users/example/project/src/App.tsx')
  assert.equal(
    localPathKindForReference('./outputs/', '/Users/example/project/outputs', cwd, true),
    'directory'
  )
})
