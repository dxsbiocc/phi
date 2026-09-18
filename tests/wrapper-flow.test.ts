import assert from 'node:assert/strict'
import test from 'node:test'

import { readLegacyFastqQcWrapperManifest } from './helpers/wrapperFixtures'
import type { WrapperManifest } from '../src/shared/wrapperManifestTypes'
import {
  buildWrapperFlowGraph,
  buildWrapperParamsFlowGraph
} from '../src/renderer/src/features/wrapper/lib/wrapperFlow'

function fastqQcManifest(): WrapperManifest {
  return readLegacyFastqQcWrapperManifest()
}

test('buildWrapperFlowGraph renders the declared fastqc -> multiqc DAG with dependency edges', () => {
  const graph = buildWrapperFlowGraph(fastqQcManifest())

  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ['fastqc', 'multiqc']
  )
  assert.equal(graph.nodes[0].data.kind, 'step')
  assert.equal(graph.nodes[0].data.label, 'FastQC')
  assert.equal(graph.nodes[0].data.state, 'pending')

  assert.deepEqual(
    graph.edges.map((edge) => [edge.source, edge.target]),
    [['fastqc', 'multiqc']]
  )

  // fastqc has no dependency, so it sits in an earlier column than multiqc.
  const fastqcNode = graph.nodes.find((node) => node.id === 'fastqc')!
  const multiqcNode = graph.nodes.find((node) => node.id === 'multiqc')!
  assert.ok(fastqcNode.position.x < multiqcNode.position.x)
})

test('buildWrapperFlowGraph reflects live per-step state when provided', () => {
  const graph = buildWrapperFlowGraph(fastqQcManifest(), {
    fastqc: 'completed',
    multiqc: 'running'
  })
  assert.equal(graph.nodes.find((node) => node.id === 'fastqc')?.data.state, 'completed')
  assert.equal(graph.nodes.find((node) => node.id === 'multiqc')?.data.state, 'running')
})

test('buildWrapperFlowGraph falls back to a trivial inputs -> wrapper -> outputs graph when no steps are declared', () => {
  const manifest = { ...fastqQcManifest(), steps: undefined, name: 'Toy Wrapper' }
  const graph = buildWrapperFlowGraph(manifest)

  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ['inputs', 'wrapper', 'outputs']
  )
  assert.equal(graph.nodes[1].data.label, 'Toy Wrapper')
  assert.deepEqual(
    graph.edges.map((edge) => [edge.source, edge.target]),
    [
      ['inputs', 'wrapper'],
      ['wrapper', 'outputs']
    ]
  )
})

test('buildWrapperParamsFlowGraph draws one node per named input/output around the wrapper', () => {
  const graph = buildWrapperParamsFlowGraph({
    name: 'fastp',
    inputLabels: ['reads'],
    outputLabels: ['reads', 'reports']
  })

  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ['in-0', 'wrapper', 'out-0', 'out-1']
  )
  assert.equal(graph.nodes[0].data.label, 'reads')
  assert.equal(graph.nodes[1].data.label, 'fastp')
  assert.equal(graph.nodes[2].data.label, 'reads')
  assert.equal(graph.nodes[3].data.label, 'reports')
  assert.deepEqual(
    graph.edges.map((edge) => [edge.source, edge.target]),
    [
      ['in-0', 'wrapper'],
      ['wrapper', 'out-0'],
      ['wrapper', 'out-1']
    ]
  )
})

test('buildWrapperParamsFlowGraph falls back to generic Inputs/Outputs labels when a wrapper declares none', () => {
  const graph = buildWrapperParamsFlowGraph({ name: 'toy', inputLabels: [], outputLabels: [] })
  assert.deepEqual(
    graph.nodes.map((node) => node.data.label),
    ['Inputs', 'toy', 'Outputs']
  )
})
