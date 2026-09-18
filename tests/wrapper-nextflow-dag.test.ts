import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

test('parseWrapperNextflowDag handles the real generated rna-seq dag.mmd end to end', () => {
  const dagPath = resolve(process.cwd(), 'resources/wrappers/workflows/rna-seq/wrapper/dag.mmd')
  const source = readFileSync(dagPath, 'utf-8')
  const graph = parseWrapperNextflowDag(source)
  assert.ok(graph)

  // 56 real processes as of when scripts/generate-wrapper-dags.mjs last ran
  // for this pipeline — a change here should track a real dag.mmd refresh,
  // not silently drift.
  assert.ok(graph!.nodes.length > 40, `expected a real process count, got ${graph!.nodes.length}`)
  assert.ok(graph!.nodes.some((node) => node.data.label === 'FASTQC'))
  assert.ok(graph!.nodes.some((node) => node.data.label === 'STAR_ALIGN'))

  // Every process node should be reachable by at least one contracted edge
  // — an isolated node would mean the contraction silently dropped a real
  // dependency somewhere.
  const connected = new Set<string>()
  for (const edge of graph!.edges) {
    connected.add(edge.source)
    connected.add(edge.target)
  }
  const isolated = graph!.nodes.filter((node) => !connected.has(node.id))
  assert.deepEqual(
    isolated.map((node) => node.data.label),
    []
  )

  // dagre lays out by dependency depth, but a spacing bug (or a future
  // change back to a naive column-index layout) could still stack distinct
  // nodes on top of each other — that's exactly the "chaotic hairball"
  // regression this layout replaced. Approximate each node as the box
  // WrapperFlowDiagram actually renders and check none of them overlap.
  const boxes = graph!.nodes.map((node) => {
    const width = Math.max(110, node.data.label.length * 7.5 + 28)
    const height = 52
    return {
      label: node.data.label,
      left: node.position.x,
      right: node.position.x + width,
      top: node.position.y,
      bottom: node.position.y + height
    }
  })
  const overlaps: string[] = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      const overlapsHorizontally = a.left < b.right && b.left < a.right
      const overlapsVertically = a.top < b.bottom && b.top < a.bottom
      if (overlapsHorizontally && overlapsVertically) {
        overlaps.push(`${a.label} <-> ${b.label}`)
      }
    }
  }
  assert.deepEqual(overlaps, [])
})
