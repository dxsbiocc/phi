import type { Edge, Node } from '@xyflow/react'

import type { WrapperManifestStep } from '../../../../../shared/wrapperManifestTypes'
import type { WrapperStepState } from '../../../../../shared/wrapperTypes'

/**
 * Turns a manifest (or a plan's manifest snapshot — see `WrapperRunPlan.steps`)
 * into `@xyflow/react` nodes/edges — the structure diagram shown on the chat
 * plan card and the Wrappers sidebar detail view (see technical design's
 * "Workflow Structure And Live Run State"). Pure and framework-agnostic
 * beyond the `@xyflow/react` node type, so it's testable without rendering
 * anything.
 *
 * Deliberately takes the narrow `WrapperFlowSource` shape rather than a full
 * manifest: a plan snapshot only carries `name`/`steps`, not the whole
 * manifest, and this function shouldn't care which one it got.
 */
export interface WrapperFlowSource {
  name: string
  steps?: WrapperManifestStep[]
}

export type WrapperFlowNodeKind = 'io' | 'step'

export interface WrapperFlowNodeData extends Record<string, unknown> {
  label: string
  kind: WrapperFlowNodeKind
  /** Only meaningful for `kind: "step"` nodes; `io` nodes are always `undefined`. */
  state?: WrapperStepState
}

export type WrapperFlowNode = Node<WrapperFlowNodeData>

export interface WrapperFlowGraph {
  nodes: WrapperFlowNode[]
  edges: Edge[]
}

const COLUMN_WIDTH = 200
const ROW_HEIGHT = 90

function computeStepDepths(steps: WrapperManifestStep[]): Map<string, number> {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const depths = new Map<string, number>()

  function depthOf(id: string, guard: Set<string>): number {
    const cached = depths.get(id)
    if (cached !== undefined) return cached
    if (guard.has(id)) return 0 // manifest.ts rejects unresolved dependsOn ids; this only guards a stray cycle
    guard.add(id)

    const step = byId.get(id)
    const dependsOn = step?.dependsOn ?? []
    const depth =
      dependsOn.length === 0 ? 0 : 1 + Math.max(...dependsOn.map((dep) => depthOf(dep, guard)))
    depths.set(id, depth)
    return depth
  }

  for (const step of steps) depthOf(step.id, new Set())
  return depths
}

function buildDeclaredStepsGraph(
  steps: WrapperManifestStep[],
  stepStates: Record<string, WrapperStepState>
): WrapperFlowGraph {
  const depths = computeStepDepths(steps)
  const countByDepth = new Map<number, number>()

  const nodes: WrapperFlowNode[] = steps.map((step) => {
    const depth = depths.get(step.id) ?? 0
    const rowIndex = countByDepth.get(depth) ?? 0
    countByDepth.set(depth, rowIndex + 1)

    return {
      id: step.id,
      position: { x: depth * COLUMN_WIDTH, y: rowIndex * ROW_HEIGHT },
      data: { label: step.label, kind: 'step', state: stepStates[step.id] ?? 'pending' },
      type: 'default'
    }
  })

  const edges: Edge[] = steps.flatMap((step) =>
    step.dependsOn.map((dependencyId) => ({
      id: `${dependencyId}->${step.id}`,
      source: dependencyId,
      target: step.id
    }))
  )

  return { nodes, edges }
}

/** No `steps` declared — never show a blank panel, fall back to a trivial 3-node graph. */
function buildFallbackGraph(source: WrapperFlowSource): WrapperFlowGraph {
  const nodes: WrapperFlowNode[] = [
    {
      id: 'inputs',
      position: { x: 0, y: 0 },
      data: { label: 'Inputs', kind: 'io' },
      type: 'input'
    },
    {
      id: 'wrapper',
      position: { x: COLUMN_WIDTH, y: 0 },
      data: { label: source.name, kind: 'step', state: 'pending' },
      type: 'default'
    },
    {
      id: 'outputs',
      position: { x: COLUMN_WIDTH * 2, y: 0 },
      data: { label: 'Outputs', kind: 'io' },
      type: 'output'
    }
  ]
  const edges: Edge[] = [
    { id: 'inputs->wrapper', source: 'inputs', target: 'wrapper' },
    { id: 'wrapper->outputs', source: 'wrapper', target: 'outputs' }
  ]
  return { nodes, edges }
}

export function buildWrapperFlowGraph(
  source: WrapperFlowSource,
  stepStates: Record<string, WrapperStepState> = {}
): WrapperFlowGraph {
  if (source.steps && source.steps.length > 0) {
    return buildDeclaredStepsGraph(source.steps, stepStates)
  }
  return buildFallbackGraph(source)
}
