import {
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Box, Typography, useTheme, type Theme } from '@mui/material'
import { memo, useMemo } from 'react'
import type { WrapperFlowGraph, WrapperFlowNode, WrapperFlowNodeData } from '../lib/wrapperFlow'

function stateColor(theme: Theme, data: WrapperFlowNodeData): string {
  if (data.kind === 'io') return theme.palette.text.secondary
  switch (data.state) {
    case 'running':
      return theme.palette.info.main
    case 'completed':
      return theme.palette.success.main
    case 'failed':
      return theme.palette.error.main
    default:
      return theme.palette.text.secondary
  }
}

const WrapperFlowStepNode = memo(function WrapperFlowStepNode({
  data,
  type
}: NodeProps<WrapperFlowNode>): React.JSX.Element {
  const theme = useTheme()
  const color = stateColor(theme, data)
  const isIo = data.kind === 'io'
  // A step node is always wired on both sides. An io node is only ever one
  // end of an edge — which end depends on its own ReactFlow `type`: an
  // "input" io node is an edge's source (feeds into a step), an "output" io
  // node is an edge's target (fed by a step). Without the matching Handle,
  // ReactFlow has no anchor to route the edge to/from and silently drops it
  // — which is why these boxes rendered with no connecting lines at all.
  const showTargetHandle = !isIo || type === 'output'
  const showSourceHandle = !isIo || type === 'input'

  return (
    <Box
      sx={{
        px: 1.25,
        py: 0.625,
        borderRadius: 0.75,
        border: '1px solid',
        borderColor: isIo ? 'divider' : color,
        bgcolor: 'background.paper',
        minWidth: 92,
        textAlign: 'center'
      }}
    >
      {showTargetHandle && <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />}
      <Typography variant="caption" sx={{ fontWeight: 600, display: 'block', lineHeight: 1.3 }}>
        {data.label}
      </Typography>
      {!isIo && (
        <Typography
          variant="caption"
          sx={{
            color,
            fontSize: '0.7rem',
            display: 'block',
            lineHeight: 1.3,
            opacity: data.state === 'pending' ? 0.65 : 1
          }}
        >
          {runStepStateLabel(data.state)}
        </Typography>
      )}
      {showSourceHandle && (
        <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      )}
    </Box>
  )
})

function runStepStateLabel(state: WrapperFlowNodeData['state']): string {
  switch (state) {
    case 'running':
      return '运行中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return '待运行'
  }
}

const nodeTypes = {
  default: WrapperFlowStepNode,
  input: WrapperFlowStepNode,
  output: WrapperFlowStepNode
}

export interface WrapperFlowDiagramProps {
  graph: WrapperFlowGraph
  height?: number
}

/**
 * Read-only structure/live-state diagram for a wrapper — see technical
 * design's "Workflow Structure And Live Run State". No drag-to-rewire, no
 * editing: this is a status view, not a workflow editor. Deliberately
 * plain — no dotted canvas background, muted borders, small type — so it
 * reads as part of this app rather than a generic node-editor widget.
 */
export function WrapperFlowDiagram({
  graph,
  height = 160
}: WrapperFlowDiagramProps): React.JSX.Element {
  const theme = useTheme()
  // A handful of nodes reads fine as a static "fit to box" thumbnail (the
  // original design intent — see this component's own doc comment). A real
  // pipeline's contracted process graph can run into dozens of nodes, which
  // just look cramped at a forced fit — let those pan/zoom instead.
  const isLarge = graph.nodes.length > 8
  const defaultEdgeOptions = useMemo(
    () => ({
      style: { strokeWidth: 1, stroke: theme.palette.text.secondary },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: theme.palette.text.secondary,
        width: 14,
        height: 14
      }
    }),
    [theme.palette.text.secondary]
  )

  return (
    <Box
      sx={{
        height,
        borderRadius: 1,
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper'
      }}
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          fitView
          fitViewOptions={{ padding: 0.35 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={isLarge}
          zoomOnScroll={isLarge}
          zoomOnPinch={isLarge}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        />
      </ReactFlowProvider>
    </Box>
  )
}
