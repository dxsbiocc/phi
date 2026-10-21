import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectBareFileReferencePaths,
  collectRemoteProjectReferencePaths,
  inlineCodeFilePath,
  isInlinePreviewImagePath,
  localHrefToPath,
  localPathKindForReference,
  tokenizeBareFileReferences
} from '../src/renderer/src/lib/markdownLocalPathReferences'

const cwd = '/Users/example/project'

test('inline image previews cover raster formats the content area can show', () => {
  assert.equal(isInlinePreviewImagePath('figures/plot.png'), true)
  assert.equal(isInlinePreviewImagePath('photo.JPG'), true)
  assert.equal(isInlinePreviewImagePath('scan.jpeg'), true)
  assert.equal(isInlinePreviewImagePath('anim.gif'), true)
  assert.equal(isInlinePreviewImagePath('plate.webp'), true)
  assert.equal(isInlinePreviewImagePath('figure.png:12'), true)
  assert.equal(isInlinePreviewImagePath('report.pdf'), false)
  assert.equal(isInlinePreviewImagePath('notes.md'), false)
  assert.equal(isInlinePreviewImagePath('.png'), false)
})

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

test('markdown local path references reject glob patterns', () => {
  assert.equal(inlineCodeFilePath('./*.pdf', cwd), null)
  assert.equal(inlineCodeFilePath('./xxx.{png,pdf}', cwd), null)
  assert.equal(localHrefToPath('./*.pdf', cwd), null)
  assert.equal(localHrefToPath('./xxx.{png,pdf}', cwd), null)
})

test('remote markdown candidates cover canonical project root and current working directory only', () => {
  assert.deepEqual(
    collectRemoteProjectReferencePaths(
      'Open `params.json`, ./report.txt, and ssh://gpu/data/project/results/final.csv.',
      '/data/project/wrappers/runs/wrun_1',
      {
        hostAlias: 'gpu',
        remoteRoot: '/data/project',
        canonicalRoot: '/data/project'
      }
    ),
    [
      '/data/project/wrappers/runs/wrun_1/params.json',
      '/data/project/params.json',
      '/data/project/wrappers/runs/wrun_1/report.txt',
      '/data/project/report.txt',
      '/data/project/results/final.csv'
    ]
  )
})

test('remote markdown candidates canonicalize remote-root aliases', () => {
  assert.deepEqual(
    collectRemoteProjectReferencePaths(
      'Open /mount/project/data.txt and ./local.txt.',
      '/mount/project/runs',
      {
        hostAlias: 'gpu',
        remoteRoot: '/mount/project',
        canonicalRoot: '/real/project'
      }
    ),
    ['/real/project/data.txt', '/real/project/runs/local.txt', '/real/project/local.txt']
  )
})

test('remote markdown candidates preserve a slash project root', () => {
  assert.deepEqual(
    collectRemoteProjectReferencePaths('Open params.json.', '/runs', {
      hostAlias: 'gpu',
      remoteRoot: '/',
      canonicalRoot: '/'
    }),
    ['/runs/params.json', '/params.json']
  )
})
