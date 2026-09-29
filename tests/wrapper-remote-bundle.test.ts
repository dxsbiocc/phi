import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  collectBundleFiles,
  ensureRemoteBundle,
  hashBundleFiles
} from '../src/main/agent/wrappers/composition/remote-bundle'
import { getBundledWrapperPackagesDir } from '../src/main/agent/wrappers/catalog'
import { componentBundleScope } from '../src/main/agent/wrappers/composition/includes'
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
  // Shared conda env / Dockerfile a module reaches via ../../../../images/...
  'images/differential-expression-r/environment.yml': 'name: de',
  'README.md': 'not part of a bundle'
}

function activeBundleArtifacts(remote: string): string[] {
  const bundles = join(remote, 'wrappers/bundles')
  return existsSync(bundles)
    ? readdirSync(bundles).filter((name) => /\.lock$|\.stale-|\.partial-|\.archive-/.test(name))
    : []
}

test('bundle files are the runnable sources only, sorted, with posix relative paths', () => {
  const { root, cleanup } = makeTree(TREE)
  try {
    assert.deepEqual(collectBundleFiles(root), [
      'images/differential-expression-r/environment.yml',
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
    assert.deepEqual(activeBundleArtifacts(remote), [])
    const marker = JSON.parse(readFileSync(join(first.bundleDir, '.phi-bundle-complete'), 'utf8'))
    assert.equal(marker.hash, first.hash)
    assert.equal(marker.files.length, collectBundleFiles(src.root).length)

    const second = await ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote })
    assert.equal(second.hash, first.hash)
    assert.equal(session.uploads.length, 1, 'an unchanged bundle must not be uploaded again')
  } finally {
    src.cleanup()
    rmSync(remote, { recursive: true, force: true })
  }
})

test('concurrent callers on the same host transfer a bundle only once', async () => {
  const src = makeTree(TREE)
  const remote = mkdtempSync(join(tmpdir(), 'phi-bundle-remote-'))
  try {
    const firstSession = createLocalShellSession()
    const secondSession = createLocalShellSession()
    const [first, second] = await Promise.all([
      ensureRemoteBundle(firstSession, { localRoot: src.root, workspaceRoot: remote }),
      ensureRemoteBundle(secondSession, { localRoot: src.root, workspaceRoot: remote })
    ])
    assert.deepEqual(second, first)
    assert.equal(firstSession.uploads.length + secondSession.uploads.length, 1)
    assert.deepEqual(activeBundleArtifacts(remote), [])
  } finally {
    src.cleanup()
    rmSync(remote, { recursive: true, force: true })
  }
})

test('a lock abandoned by a disconnected uploader is reclaimed before retry', async () => {
  const src = makeTree(TREE)
  const remote = mkdtempSync(join(tmpdir(), 'phi-bundle-remote-'))
  try {
    const hash = hashBundleFiles(src.root, collectBundleFiles(src.root))
    const lockDir = join(remote, 'wrappers/bundles', `${hash}.lock`)
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'owner'), 'disconnected')
    const old = new Date(Date.now() - 120_000)
    utimesSync(lockDir, old, old)
    const session = createLocalShellSession()
    const result = await ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote })
    assert.equal(result.hash, hash)
    assert.equal(session.uploads.length, 1)
    assert.deepEqual(activeBundleArtifacts(remote), [])
  } finally {
    src.cleanup()
    rmSync(remote, { recursive: true, force: true })
  }
})

test('large server scans use the session bounded command path when available', async () => {
  const src = makeTree(TREE)
  const remote = mkdtempSync(join(tmpdir(), 'phi-bundle-remote-'))
  try {
    const session = createLocalShellSession()
    const direct = session.exec
    let bounded = 0
    session.execBounded = async (command, options) => {
      bounded += 1
      assert.ok(options.timeoutMs >= 120_000)
      assert.ok(options.maxOutputBytes <= 8192)
      return { ...(await direct(command)), stdoutTruncated: false, stderrTruncated: false }
    }
    await ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote })
    assert.ok(bounded >= 3, 'remote verification and extraction use bounded commands')
  } finally {
    src.cleanup()
    rmSync(remote, { recursive: true, force: true })
  }
})

test('damaged content or a forged completion marker is repaired before reuse', async () => {
  const src = makeTree(TREE)
  const remote = mkdtempSync(join(tmpdir(), 'phi-bundle-remote-'))
  try {
    const session = createLocalShellSession()
    const first = await ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote })
    const main = join(first.bundleDir, 'modules/nf-core/fastqc/main.nf')
    writeFileSync(main, 'tampered')
    await ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote })
    assert.equal(session.uploads.length, 2)
    assert.equal(readFileSync(main, 'utf8'), TREE['modules/nf-core/fastqc/main.nf'])
    writeFileSync(join(first.bundleDir, '.phi-bundle-complete'), '{"hash":"forged"}')
    await ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote })
    assert.equal(session.uploads.length, 3)
    assert.equal(readFileSync(main, 'utf8'), TREE['modules/nf-core/fastqc/main.nf'])
    writeFileSync(join(first.bundleDir, 'unexpected.txt'), 'not in manifest')
    await ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote })
    assert.equal(session.uploads.length, 4)
    assert.equal(existsSync(join(first.bundleDir, 'unexpected.txt')), false)
    assert.deepEqual(activeBundleArtifacts(remote), [])
  } finally {
    src.cleanup()
    rmSync(remote, { recursive: true, force: true })
  }
})

test('a source change after hashing cannot publish under the earlier content hash', async () => {
  const src = makeTree(TREE)
  const remote = mkdtempSync(join(tmpdir(), 'phi-bundle-remote-'))
  try {
    const session = createLocalShellSession()
    const oldHash = hashBundleFiles(src.root, collectBundleFiles(src.root))
    const realMkdir = session.mkdirp
    session.mkdirp = async (path) => {
      await realMkdir(path)
      writeFileSync(join(src.root, 'modules/nf-core/fastqc/main.nf'), 'changed after snapshot')
    }
    await assert.rejects(
      ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote }),
      /校验失败/
    )
    assert.equal(existsSync(join(remote, 'wrappers/bundles', oldHash)), false)
    assert.deepEqual(activeBundleArtifacts(remote), [])
  } finally {
    src.cleanup()
    rmSync(remote, { recursive: true, force: true })
  }
})

test('an interrupted transfer cannot overwrite an already available version', async () => {
  const src = makeTree(TREE)
  const remote = mkdtempSync(join(tmpdir(), 'phi-bundle-remote-'))
  try {
    const session = createLocalShellSession()
    const first = await ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote })
    const source = join(src.root, 'modules/nf-core/fastqc/main.nf')
    writeFileSync(source, 'process V2 {}')
    const secondHash = hashBundleFiles(src.root, collectBundleFiles(src.root))
    const realUpload = session.uploadFile
    session.uploadFile = async (local, target) => {
      await realUpload(local, target)
      throw new Error('SSH upload interrupted')
    }
    await assert.rejects(
      ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote }),
      /upload interrupted/
    )
    assert.equal(existsSync(join(remote, 'wrappers/bundles', secondHash)), false)
    assert.equal(
      readFileSync(join(first.bundleDir, 'modules/nf-core/fastqc/main.nf'), 'utf8'),
      TREE['modules/nf-core/fastqc/main.nf']
    )
    assert.deepEqual(activeBundleArtifacts(remote), [])
    session.uploadFile = realUpload
    const second = await ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote })
    assert.equal(second.hash, secondHash)
  } finally {
    src.cleanup()
    rmSync(remote, { recursive: true, force: true })
  }
})

test('corrupted extracted files never receive a published completion marker', async () => {
  const src = makeTree(TREE)
  const remote = mkdtempSync(join(tmpdir(), 'phi-bundle-remote-'))
  try {
    const session = createLocalShellSession()
    const realWrite = session.writeTextFile
    session.writeTextFile = async (path, content) => {
      await realWrite(path, content)
      if (path.endsWith('/.phi-bundle-complete')) {
        writeFileSync(join(dirname(path), 'modules/nf-core/fastqc/main.nf'), 'corrupt transfer')
      }
    }
    await assert.rejects(
      ensureRemoteBundle(session, { localRoot: src.root, workspaceRoot: remote }),
      /校验失败/
    )
    const hash = hashBundleFiles(src.root, collectBundleFiles(src.root))
    assert.equal(existsSync(join(remote, 'wrappers/bundles', hash)), false)
    assert.deepEqual(activeBundleArtifacts(remote), [])
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

test('a scoped check re-reads only the directories the run uses, but still catches a forged marker', async () => {
  const src = makeTree(TREE)
  const remote = mkdtempSync(join(tmpdir(), 'phi-bundle-remote-'))
  try {
    const session = createLocalShellSession()
    const scope = ['modules/nf-core/fastqc']
    const first = await ensureRemoteBundle(session, {
      localRoot: src.root,
      workspaceRoot: remote,
      verifyScope: scope
    })
    assert.equal(session.uploads.length, 1)

    // Outside the scope: not re-read, so the bundle is reused as is.
    writeFileSync(join(first.bundleDir, 'subworkflows/nf-core/x/main.nf'), 'changed elsewhere')
    await ensureRemoteBundle(session, {
      localRoot: src.root,
      workspaceRoot: remote,
      verifyScope: scope
    })
    assert.equal(session.uploads.length, 1)

    // Inside the scope: tampering is caught and the bundle is replaced.
    const main = join(first.bundleDir, 'modules/nf-core/fastqc/main.nf')
    writeFileSync(main, 'tampered')
    await ensureRemoteBundle(session, {
      localRoot: src.root,
      workspaceRoot: remote,
      verifyScope: scope
    })
    assert.equal(session.uploads.length, 2)
    assert.equal(readFileSync(main, 'utf8'), TREE['modules/nf-core/fastqc/main.nf'])

    // An extra file inside the scope, or a forged marker, is caught too.
    writeFileSync(join(first.bundleDir, 'modules/nf-core/fastqc/extra.nf'), 'not in manifest')
    await ensureRemoteBundle(session, {
      localRoot: src.root,
      workspaceRoot: remote,
      verifyScope: scope
    })
    assert.equal(session.uploads.length, 3)
    writeFileSync(join(first.bundleDir, '.phi-bundle-complete'), '{"hash":"forged"}')
    await ensureRemoteBundle(session, {
      localRoot: src.root,
      workspaceRoot: remote,
      verifyScope: scope
    })
    assert.equal(session.uploads.length, 4)
    assert.deepEqual(activeBundleArtifacts(remote), [])
  } finally {
    src.cleanup()
    rmSync(remote, { recursive: true, force: true })
  }
})

test('an archive damaged in transfer is rejected before it is unpacked', async () => {
  const src = makeTree(TREE)
  const remote = mkdtempSync(join(tmpdir(), 'phi-bundle-remote-'))
  try {
    const session = createLocalShellSession()
    const realUpload = session.uploadFile
    session.uploadFile = async (local, target) => {
      await realUpload(local, target)
      writeFileSync(target, 'truncated archive')
    }
    await assert.rejects(
      ensureRemoteBundle(session, {
        localRoot: src.root,
        workspaceRoot: remote,
        verifyScope: ['modules/nf-core/fastqc']
      }),
      /压缩包校验失败/
    )
    const hash = hashBundleFiles(src.root, collectBundleFiles(src.root))
    assert.equal(existsSync(join(remote, 'wrappers/bundles', hash)), false)
    assert.deepEqual(activeBundleArtifacts(remote), [])
  } finally {
    src.cleanup()
    rmSync(remote, { recursive: true, force: true })
  }
})

test('a run bundle scope covers the component and every module it includes', () => {
  const root = getBundledWrapperPackagesDir()
  assert.deepEqual(componentBundleScope(join(root, 'modules/nf-core/star/align'), root), [
    'modules/nf-core/star/align',
    'modules/nf-core/star/genomegenerate'
  ])
  const scope = componentBundleScope(join(root, 'subworkflows/local/align_star'), root)
  assert.ok(scope.includes('subworkflows/local/align_star'))
  assert.ok(scope.includes('modules/nf-core/star/genomegenerate'))
  assert.ok(scope.some((dir) => dir.startsWith('modules/nf-core/samtools/')))
})
