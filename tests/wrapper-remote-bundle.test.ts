import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  collectBundleFiles,
  ensureRemoteBundle,
  hashBundleFiles
} from '../src/main/agent/wrappers/composition/remote-bundle'
import { createLocalShellSession } from './helpers/localShellSession'

function makeTree(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'phi-bundle-src-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const TREE = {
  'modules/nf-core/fastqc/main.nf': 'process FASTQC {}',
  'modules/nf-core/fastqc/environment.yml': 'name: x',
  'modules/nf-core/fastqc/wrapper/main.nf': 'include {} from "../main.nf"',
  'modules/nf-core/fastqc/wrapper/params.json': '{}',
  'modules/nf-core/fastqc/wrapper/dag.mmd': 'flowchart',
  'modules/nf-core/fastqc/tests/data/big.fastq.gz': 'BIG',
  'modules/nf-core/fastqc/.DS_Store': 'junk',
  'modules/nf-core/fastqc/work/ab/cd/out.txt': 'stale run output',
  'subworkflows/nf-core/x/main.nf': 'workflow X {}',
  'README.md': 'not part of a bundle'
}

test('bundle files are the runnable sources only, sorted, with posix relative paths', () => {
  const { root, cleanup } = makeTree(TREE)
  try {
    assert.deepEqual(collectBundleFiles(root), [
      'modules/nf-core/fastqc/environment.yml',
      'modules/nf-core/fastqc/main.nf',
      'modules/nf-core/fastqc/wrapper/main.nf',
      'modules/nf-core/fastqc/wrapper/params.json',
      'subworkflows/nf-core/x/main.nf'
    ])
  } finally {
    cleanup()
  }
})

test('test fixtures ship only for a component whose default params point at them', () => {
  const { root, cleanup } = makeTree({
    ...TREE,
    'modules/nf-core/gffread/main.nf': 'process GFFREAD {}',
    'modules/nf-core/gffread/wrapper/params.json': '{"gff": "tests/data/genome.gff3"}',
    'modules/nf-core/gffread/tests/data/genome.gff3': 'gff',
    'modules/nf-core/gffread/tests/main.nf.test': 'nf-test, not a fixture'
  })
  try {
    const files = collectBundleFiles(root)
    assert.ok(files.includes('modules/nf-core/gffread/tests/data/genome.gff3'))
    assert.ok(!files.includes('modules/nf-core/gffread/tests/main.nf.test'))
    assert.ok(!files.includes('modules/nf-core/fastqc/tests/data/big.fastq.gz'))
  } finally {
    cleanup()
  }
})

test('the bundle hash follows content and paths, not timestamps', () => {
  const a = makeTree(TREE)
  const b = makeTree(TREE)
  const c = makeTree({ ...TREE, 'modules/nf-core/fastqc/main.nf': 'process CHANGED {}' })
  try {
    const hash = (root: string): string => hashBundleFiles(root, collectBundleFiles(root))
    assert.equal(hash(a.root), hash(b.root))
    assert.notEqual(hash(a.root), hash(c.root))
    assert.match(hash(a.root), /^[0-9a-f]{12}$/)
  } finally {
    a.cleanup()
    b.cleanup()
    c.cleanup()
  }
})

test('ensureRemoteBundle uploads once, unpacks the sources, and reuses the bundle afterwards', async () => {
  const src = makeTree(TREE)
  const remote = mkdtempSync(join(tmpdir(), 'phi-bundle-remote-'))
  try {
    const session = createLocalShellSession()
    const first = await ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote })
    assert.equal(session.uploads.length, 1)
    assert.equal(first.bundleDir, `${remote}/wrappers/bundles/${first.hash}`)
    assert.equal(
      readFileSync(join(first.bundleDir, 'modules/nf-core/fastqc/wrapper/main.nf'), 'utf-8'),
      'include {} from "../main.nf"'
    )
    assert.equal(existsSync(join(first.bundleDir, 'modules/nf-core/fastqc/tests')), false)
    assert.equal(existsSync(join(first.bundleDir, 'modules/nf-core/fastqc/.DS_Store')), false)
    // the shipped archive is not left behind
    assert.equal(existsSync(`${first.bundleDir}.tar.gz`), false)

    const second = await ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote })
    assert.equal(second.hash, first.hash)
    assert.equal(session.uploads.length, 1, 'an unchanged bundle must not be uploaded again')
  } finally {
    src.cleanup()
    rmSync(remote, { recursive: true, force: true })
  }
})

test('a changed source tree ships as a new bundle beside the old one', async () => {
  const src = makeTree(TREE)
  const remote = mkdtempSync(join(tmpdir(), 'phi-bundle-remote-'))
  try {
    const session = createLocalShellSession()
    const first = await ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote })
    writeFileSync(join(src.root, 'modules/nf-core/fastqc/main.nf'), 'process V2 {}')
    const second = await ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote })
    assert.notEqual(second.bundleDir, first.bundleDir)
    assert.equal(existsSync(first.bundleDir), true, 'runs still using the old bundle keep working')
    assert.equal(
      readFileSync(join(second.bundleDir, 'modules/nf-core/fastqc/main.nf'), 'utf-8'),
      'process V2 {}'
    )
  } finally {
    src.cleanup()
    rmSync(remote, { recursive: true, force: true })
  }
})

test('a failed remote unpack is reported, not silently treated as a bundle', async () => {
  const src = makeTree(TREE)
  const remote = mkdtempSync(join(tmpdir(), 'phi-bundle-remote-'))
  try {
    const session = createLocalShellSession()
    const realExec = session.exec
    session.exec = async (command) =>
      command.includes('tar')
        ? { stdout: '', stderr: 'tar: disk full', code: 2, signal: null }
        : realExec(command)
    await assert.rejects(
      ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote }),
      /disk full/
    )
  } finally {
    src.cleanup()
    rmSync(remote, { recursive: true, force: true })
  }
})
