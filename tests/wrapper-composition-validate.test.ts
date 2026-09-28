import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { WrapperCompositionManifest } from '../src/main/agent/wrappers/composition/manifest'
import {
  findMissingPrimaryOutputs,
  validateWrapperParams
} from '../src/main/agent/wrappers/composition/validate'

const manifest: WrapperCompositionManifest = {
  id: 'acme/modules/toy',
  name: 'Toy',
  summary: 'Toy wrapper',
  params: {
    reads: { kind: 'input', type: 'file', required: true },
    outdir: { kind: 'output', type: 'path', required: true },
    threads: { kind: 'option', type: 'integer', required: false, minimum: 1, maximum: 8 },
    mode: { kind: 'option', type: 'string', required: false, enum: ['fast', 'slow'] },
    verbose: { kind: 'option', type: 'boolean', required: false }
  },
  outputs: {
    report: { type: 'directory', path: '${outdir}/toy', primary: true },
    extra: { type: 'file', path: '${outdir}/extra.txt', primary: false }
  }
}

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'phi-wrapper-validate-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('validateWrapperParams accepts a complete, well-typed parameter set', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'a.txt'), 'x')
    const defaults = { reads: 'a.txt', outdir: 'results' }
    const errors = validateWrapperParams(manifest, defaults, { threads: 4, mode: 'fast' }, dir)
    assert.deepEqual(errors, [])
  })
})

test('validateWrapperParams reports missing required params after merging defaults', () => {
  withDir((dir) => {
    const errors = validateWrapperParams(manifest, { outdir: 'results' }, {}, dir)
    assert.deepEqual(errors, ['Missing required parameter: reads'])
  })
})

test('validateWrapperParams treats null and empty string as missing', () => {
  withDir((dir) => {
    const errors = validateWrapperParams(manifest, { reads: null, outdir: '' }, {}, dir)
    assert.deepEqual(errors, [
      'Missing required parameter: reads',
      'Missing required parameter: outdir'
    ])
  })
})

test('validateWrapperParams rejects override keys that are neither declared nor defaulted', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'a.txt'), 'x')
    const errors = validateWrapperParams(
      manifest,
      { reads: 'a.txt', outdir: 'results' },
      { read: 'b.txt' },
      dir
    )
    assert.equal(errors.length, 1)
    assert.match(errors[0], /Unknown parameter: read/)
    assert.match(errors[0], /reads/)
  })
})

test('validateWrapperParams allows overriding a key that only exists in the defaults', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'a.txt'), 'x')
    const errors = validateWrapperParams(
      manifest,
      { reads: 'a.txt', outdir: 'results', ribo_manifest: 'a.txt' },
      { ribo_manifest: 'b.txt' },
      dir
    )
    assert.deepEqual(errors, [])
  })
})

test('validateWrapperParams checks integer, boolean, enum and range constraints', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'a.txt'), 'x')
    const defaults = { reads: 'a.txt', outdir: 'results' }
    assert.match(
      validateWrapperParams(manifest, defaults, { threads: 1.5 }, dir)[0],
      /threads must be an integer/
    )
    assert.match(
      validateWrapperParams(manifest, defaults, { threads: 99 }, dir)[0],
      /threads must be <= 8/
    )
    assert.match(
      validateWrapperParams(manifest, defaults, { threads: 0 }, dir)[0],
      /threads must be >= 1/
    )
    assert.match(
      validateWrapperParams(manifest, defaults, { mode: 'medium' }, dir)[0],
      /mode must be one of: fast, slow/
    )
    assert.match(
      validateWrapperParams(manifest, defaults, { verbose: 'yes' }, dir)[0],
      /verbose must be a boolean/
    )
  })
})

test('validateWrapperParams requires plain-path inputs to exist but skips URLs and globs', () => {
  withDir((dir) => {
    const missing = validateWrapperParams(manifest, { reads: 'nope.txt', outdir: 'r' }, {}, dir)
    assert.match(missing[0], /reads: input path does not exist: nope\.txt/)

    assert.deepEqual(
      validateWrapperParams(manifest, { reads: 'https://example.org/a.txt', outdir: 'r' }, {}, dir),
      []
    )
    assert.deepEqual(
      validateWrapperParams(manifest, { reads: 'data/*.fastq.gz', outdir: 'r' }, {}, dir),
      []
    )
  })
})

test('findMissingPrimaryOutputs interpolates params and only checks primary outputs', () => {
  withDir((dir) => {
    mkdirSync(join(dir, 'results', 'toy'), { recursive: true })
    assert.deepEqual(findMissingPrimaryOutputs(manifest, { outdir: 'results' }, dir), [])

    rmSync(join(dir, 'results'), { recursive: true, force: true })
    assert.deepEqual(findMissingPrimaryOutputs(manifest, { outdir: 'results' }, dir), [
      'report (results/toy)'
    ])
  })
})

test('findMissingPrimaryOutputs honours an absolute outdir override', () => {
  withDir((dir) => {
    const outdir = join(dir, 'abs-out')
    mkdirSync(join(outdir, 'toy'), { recursive: true })
    assert.deepEqual(findMissingPrimaryOutputs(manifest, { outdir }, dir), [])
  })
})

test('a paired-reads glob that picks samples with braces or brackets before the last * is rejected', () => {
  const pairs: WrapperCompositionManifest = {
    ...manifest,
    params: {
      reads: { kind: 'input', type: 'fastq_glob', required: true },
      outdir: { kind: 'output', type: 'path', required: true }
    }
  }
  const check = (reads: string): string[] =>
    validateWrapperParams(pairs, {}, { reads, outdir: 'out' }, '/tmp', { checkInputPaths: false })

  // Nextflow names each sample by the file name up to the first { or [, so these merge samples.
  for (const reads of [
    '/data/raw/L1MKG17071{04,05}-*.R{1,2}.raw.fastq.gz',
    '/data/raw/L1MKG17071[01][0124-8]-*.R{1,2}.raw.fastq.gz'
  ]) {
    const errors = check(reads)
    assert.equal(errors.length, 1, reads)
    assert.match(errors[0], /reads/)
    assert.match(errors[0], /one sample/)
  }
  // Braces only in the read-pair part, or brackets after the last *, keep samples apart.
  for (const reads of [
    '/data/raw/*_R{1,2}.fastq.gz',
    '/data/raw/*.R{1,2}.raw.fastq.gz',
    '/data/{run1,run2}/*_R{1,2}.fastq.gz',
    '/data/raw/L1MKG*-HFD_Thrsp_KO[23].R{1,2}.raw.fastq.gz',
    '/data/raw/sample_R{1,2}.fastq.gz'
  ]) {
    assert.deepEqual(check(reads), [], reads)
  }
})
