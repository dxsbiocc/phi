import assert from 'node:assert/strict'
import test from 'node:test'

import { parseWrapperNextflowDag } from '../src/renderer/src/features/wrapper/lib/wrapperNextflowDag'

// A trimmed-down but structurally real fragment of what Nextflow's own
// `-preview -with-dag` actually emits (see scripts/generate-wrapper-dags.mjs):
// real processes as stadium nodes `id(["NAME"])`, everything else (channel
// operators, merge/fan circles, blank boxes) as plumbing between them.
const SAMPLE_DAG = `flowchart TB
    subgraph " "
    v0["channel.fromFilePairs"]
    end
    v1(( ))
    v2(["FASTQC"])
    v3["ch_fastqc_html"]
    v4(["TRIMGALORE"])
    v5["ch_trimmed_reads"]
    v6(["MULTIQC"])
    v0 --> v1
    v1 --> v2
    v1 --> v4
    v2 --> v3
    v3 --> v6
    v4 --> v5
    v5 --> v6
`

test('parseWrapperNextflowDag collapses channel/value plumbing into direct process-to-process edges', () => {
  const graph = parseWrapperNextflowDag(SAMPLE_DAG)
  assert.ok(graph)

  assert.deepEqual(graph!.nodes.map((node) => node.data.label).sort(), [
    'FASTQC',
    'MULTIQC',
    'TRIMGALORE'
  ])
  assert.ok(graph!.nodes.every((node) => node.data.kind === 'step'))

  // v0 (channel.fromFilePairs) and v1 (the merge circle) are both plumbing
  // upstream of FASTQC/TRIMGALORE with no process ancestor of their own, so
  // they contract away entirely rather than becoming a fake third edge —
  // only real process-to-process dependencies survive.
  const labelById = new Map(graph!.nodes.map((node) => [node.id, node.data.label]))
  const namedEdges = graph!.edges
    .map((edge) => [labelById.get(edge.source), labelById.get(edge.target)])
    .sort()
  assert.deepEqual(namedEdges, [
    ['FASTQC', 'MULTIQC'],
    ['TRIMGALORE', 'MULTIQC']
  ])
})

test('parseWrapperNextflowDag returns undefined when the source has no real process nodes', () => {
  const graph = parseWrapperNextflowDag('flowchart TB\n    v0["just a channel op"]\n')
  assert.equal(graph, undefined)
})

test('parseWrapperNextflowDag keeps a large branching graph connected with non-overlapping process boxes', () => {
  const lines = ['flowchart TB']
  for (let level = 0; level < 9; level++) {
    for (let branch = 0; branch < 6; branch++) {
      lines.push(`    v${level * 6 + branch}(["PROCESS_${level}_${branch}"])`)
      if (level > 0) {
        lines.push(`    v${100 + level * 6 + branch}["channel.map"]`)
        lines.push(`    v${(level - 1) * 6 + branch} --> v${100 + level * 6 + branch}`)
        lines.push(`    v${100 + level * 6 + branch} --> v${level * 6 + branch}`)
      }
      if (level === 8 && branch > 0) lines.push(`    v${42 + branch} --> v48`)
    }
  }
  const graph = parseWrapperNextflowDag(lines.join('\n'))
  assert.ok(graph)
  assert.equal(graph.nodes.length, 54)
  assert.equal(graph.edges.length, 53)
  const connected = new Set(graph.edges.flatMap((edge) => [edge.source, edge.target]))
  assert.ok(graph.nodes.every((node) => connected.has(node.id)))
  const boxes = graph.nodes.map((node) => ({
    label: node.data.label,
    left: node.position.x,
    right: node.position.x + Math.max(110, node.data.label.length * 7.5 + 28),
    top: node.position.y,
    bottom: node.position.y + 52
  }))
  const overlaps: string[] = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
        overlaps.push(`${a.label} <-> ${b.label}`)
      }
    }
  }
  assert.deepEqual(overlaps, [])
})
