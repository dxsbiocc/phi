import { Handle, Position, ReactFlow, ReactFlowProvider, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Box, Typography, useTheme, type Theme } from '@mui/material'
import { memo } from 'react'
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
  data
}: NodeProps<WrapperFlowNode>): React.JSX.Element {
  const theme = useTheme()
  const color = stateColor(theme, data)
  const isIo = data.kind === 'io'

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
      {!isIo && <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />}
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
      {!isIo && <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />}
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

const defaultEdgeOptions = {
  style: { strokeWidth: 1 }
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
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        />
      </ReactFlowProvider>
    </Box>
  )
}
