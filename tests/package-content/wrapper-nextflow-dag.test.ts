import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseWrapperNextflowDag } from '../../src/renderer/src/features/wrapper/lib/wrapperNextflowDag'
import { packageContentPath } from '../helpers/packageContent'

test('parseWrapperNextflowDag handles a real generated multi-process dag.mmd end to end', () => {
  const dagPath = packageContentPath(
    'wrappers',
    'subworkflows/nf-core/fastq_qc_trim_filter_setstrandedness/wrapper/dag.mmd'
  )
  const source = readFileSync(dagPath, 'utf-8')
  const graph = parseWrapperNextflowDag(source)
  assert.ok(graph)

  // Real processes from scripts/generate-wrapper-dags.mjs across nested subworkflows
  // — a change here should track a real dag.mmd refresh, not silently drift.
  assert.ok(graph!.nodes.length >= 8, `expected a real process count, got ${graph!.nodes.length}`)
  assert.ok(graph!.nodes.some((node) => node.data.label === 'FASTP'))
  assert.ok(graph!.nodes.some((node) => node.data.label === 'SALMON_QUANT'))

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
