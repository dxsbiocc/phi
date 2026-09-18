import * as dagre from '@dagrejs/dagre'
import type { Edge } from '@xyflow/react'
import type { WrapperFlowGraph, WrapperFlowNode } from './wrapperFlow'

/** Matches the rendered box in WrapperFlowDiagram closely enough for dagre
 * to space nodes sensibly — it only needs to avoid overlap, not be exact. */
const NODE_HEIGHT = 52
const MIN_NODE_WIDTH = 110
const CHAR_WIDTH = 7.5
const NODE_HORIZONTAL_PADDING = 28

interface RawNode {
  id: string
  isProcess: boolean
  label: string
}

const PROCESS_NODE_RE = /^(v\d+)\(\["(.*)"\]\)$/
/** Any other node shape Nextflow's `-with-dag` emits: plain box `["…"]`,
 * blank box `[" "]`, merge/fan circle `(( ))`/`((…))` — all channel/value
 * plumbing, not a real process. */
const OTHER_NODE_RE = /^(v\d+)(\[.*\]|\(\(.*\)\))$/
const EDGE_RE = /^(v\d+)\s*-->\s*(v\d+)$/

function parseNodesAndEdges(source: string): {
  nodes: Map<string, RawNode>
  adjacency: Map<string, string[]>
} {
  const nodes = new Map<string, RawNode>()
  const adjacency = new Map<string, string[]>()

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim()

    const processMatch = PROCESS_NODE_RE.exec(line)
    if (processMatch) {
      nodes.set(processMatch[1], { id: processMatch[1], isProcess: true, label: processMatch[2] })
      continue
    }

    const otherMatch = OTHER_NODE_RE.exec(line)
    if (otherMatch && !nodes.has(otherMatch[1])) {
      nodes.set(otherMatch[1], { id: otherMatch[1], isProcess: false, label: '' })
      continue
    }

    const edgeMatch = EDGE_RE.exec(line)
    if (edgeMatch) {
      const [, from, to] = edgeMatch
      const list = adjacency.get(from) ?? []
      list.push(to)
      adjacency.set(from, list)
    }
  }

  return { nodes, adjacency }
}

/**
 * Collapses every non-process (channel/value plumbing) node out of the
 * graph: for each process, follows its outgoing edges through any number of
 * plumbing nodes until it reaches another process, and records a direct
 * edge to it. A pipeline's raw `-with-dag` export is mostly this plumbing —
 * see the module doc comment on why it's not fit to show as-is.
 */
function contractToProcessEdges(
  nodes: Map<string, RawNode>,
  adjacency: Map<string, string[]>
): Set<string> {
  const edgeKeys = new Set<string>()

  for (const node of nodes.values()) {
    if (!node.isProcess) continue

    const seen = new Set<string>([node.id])
    const stack = [...(adjacency.get(node.id) ?? [])]

    while (stack.length > 0) {
      const nextId = stack.pop()!
      if (seen.has(nextId)) continue
      seen.add(nextId)

      const nextNode = nodes.get(nextId)
      if (nextNode?.isProcess) {
        edgeKeys.add(`${node.id}->${nextId}`)
        continue // don't traverse past a process — it's its own BFS root
      }
      stack.push(...(adjacency.get(nextId) ?? []))
    }
  }

  return edgeKeys
}

/**
 * Assigns a `{x, y}` per process via dagre's layered-graph layout —
 * columns by dependency depth same as before, but rows within a column are
 * ordered (and iteratively re-ordered across columns) to minimize edge
 * crossings, which a plain "longest-path depth, arrival order within
 * column" placement never did. A hand-rolled crossing-reduction pass is a
 * well-trodden, easy-to-get-subtly-wrong algorithm (Sugiyama-style layered
 * layout) — dagre already implements it correctly, and is the layout
 * library `@xyflow/react`'s own docs point to for exactly this case.
 */
function layoutWithDagre(
  processIds: string[],
  nodes: Map<string, RawNode>,
  edgeKeys: Set<string>
): Map<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 96 })
  graph.setDefaultEdgeLabel(() => ({}))

  for (const id of processIds) {
    const label = nodes.get(id)?.label ?? id
    const width = Math.max(MIN_NODE_WIDTH, label.length * CHAR_WIDTH + NODE_HORIZONTAL_PADDING)
    graph.setNode(id, { width, height: NODE_HEIGHT })
  }
  for (const key of edgeKeys) {
    const [from, to] = key.split('->')
    graph.setEdge(from, to)
  }

  dagre.layout(graph)

  const positions = new Map<string, { x: number; y: number }>()
  for (const id of processIds) {
    const laidOut = graph.node(id) as { x: number; y: number; width: number; height: number }
    // dagre positions are node centers; ReactFlow positions are top-left.
    positions.set(id, { x: laidOut.x - laidOut.width / 2, y: laidOut.y - laidOut.height / 2 })
  }
  return positions
}

/**
 * Parses Nextflow's own `-preview -with-dag` Mermaid export (see
 * `scripts/generate-wrapper-dags.mjs`) into a clean process-level graph:
 * only real processes as nodes, with a direct edge wherever one process's
 * output eventually reaches another's input through any number of
 * channel/value operators. Returns `undefined` if the source doesn't look
 * like a Nextflow dag export (e.g. failed to generate) rather than
 * rendering an empty graph.
 */
export function parseWrapperNextflowDag(source: string): WrapperFlowGraph | undefined {
  const { nodes, adjacency } = parseNodesAndEdges(source)
  const processIds = [...nodes.values()].filter((node) => node.isProcess).map((node) => node.id)
  if (processIds.length === 0) return undefined

  const edgeKeys = contractToProcessEdges(nodes, adjacency)
  const positions = layoutWithDagre(processIds, nodes, edgeKeys)

  const flowNodes: WrapperFlowNode[] = processIds.map((id) => ({
    id,
    position: positions.get(id) ?? { x: 0, y: 0 },
    data: { label: nodes.get(id)?.label ?? id, kind: 'step', state: 'pending' },
    type: 'default'
  }))

  const edges: Edge[] = [...edgeKeys].map((key) => {
    const [from, to] = key.split('->')
    return { id: key, source: from, target: to }
  })

  return { nodes: flowNodes, edges }
}
