import assert from 'node:assert/strict'
import test from 'node:test'

import {
  countDagProcesses,
  createProgressTracker
} from '../src/main/agent/wrappers/composition/progress'

test('countDagProcesses counts distinct process nodes and ignores channel plumbing', () => {
  const dag = [
    'flowchart TB',
    '    subgraph " "',
    '    v0["channel.fromPath"]',
    '    end',
    '    v2(["FASTQC"])',
    '    v3(["SAMTOOLS_SORT"])',
    '    v4(["SAMTOOLS_SORT"])',
    '    v5(( ))',
    '    v0 --> v2'
  ].join('\n')
  assert.equal(countDagProcesses(dag), 2)
  assert.equal(countDagProcesses(undefined), undefined)
  assert.equal(countDagProcesses('flowchart TB\n    v0["x"]'), undefined)
})

test('the tracker recognises Nextflow 26 process lines and reports distinct processes', () => {
  const tracker = createProgressTracker({ total: 6 })
  tracker.push('[PIPELINE] main.nf | profile=docker\n')
  tracker.push('[PROCESS 87/ef5c73] SALMON_INDEX (transcriptome.fasta)\n')
  tracker.push('[PROCESS 53/8cbdf6] QUANTIFY_PSEUDO_ALIGNMENT:SALMON_QUANT (sample)\n')
  tracker.push('[PROCESS 54/8cbdf7] QUANTIFY_PSEUDO_ALIGNMENT:SALMON_QUANT (sample2)\n')
  assert.deepEqual(tracker.snapshot(), { started: 2, total: 6, current: 'SALMON_QUANT' })
})

test('the tracker also understands the classic Submitted/Cached process lines', () => {
  const tracker = createProgressTracker()
  tracker.push('[ab/123456] Submitted process > FASTQC (s1)\n')
  tracker.push('[cd/654321] Cached process > FASTP (s1)\n')
  assert.deepEqual(tracker.snapshot(), { started: 2, current: 'FASTP' })
})

test('lines split across chunks are reassembled, and noise is ignored', () => {
  const tracker = createProgressTracker()
  tracker.push('[PROCESS 87/ef5')
  tracker.push('c73] FASTQC (s1)\nsome random log line\n[SUC')
  tracker.push('CESS] completed=1 failed=0 cached=0\n')
  assert.deepEqual(tracker.snapshot(), { started: 1, current: 'FASTQC' })
})

test('the tail keeps the newest complete lines within maxLines, plus an unfinished last line', () => {
  const tracker = createProgressTracker({ maxLines: 3 })
  tracker.push('one\ntwo\nthree\nfour\nfive')
  assert.equal(tracker.tail(), 'two\nthree\nfour\nfive')
  assert.equal(tracker.tail(6), 'r\nfive')
  assert.equal(createProgressTracker().tail(), '')
})
