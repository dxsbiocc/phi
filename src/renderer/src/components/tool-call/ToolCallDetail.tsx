import { Box, Button, Divider, Typography } from '@mui/material'
import { useState, type ReactNode } from 'react'
import { fileIconForPath } from '../../icons'
import type { ToolCallItem } from '../../types'
import { DbQueryResultPreview } from '../../features/databases/components/DbQueryResultPreview'
import { toolTargetFromArgs } from '../../lib/toolTargets'
import {
  formatBytes,
  isOutputPreviewTruncated,
  isToolArgsPreviewTruncated,
  outputPreviewText,
  toolArgsPreviewText
} from '../../lib/toolOutputPresentation'
import { TimelineRail } from '../chat/TimelineRail'
import { NotebookToolSummaryBlock } from './NotebookToolSummary'
import { DiffAwareOutput } from './ToolOutputText'

export function ToolCallDetail({ item, cwd }: { item: ToolCallItem; cwd?: string }): ReactNode {
  const [showFullArgs, setShowFullArgs] = useState(false)
  const [showFullOutput, setShowFullOutput] = useState(false)
  const target = toolTargetFromArgs(item.toolName, item.argsJson, cwd ?? '')
  const targetIcon = target ? fileIconForPath(target.absolutePath) : null
  const TargetFileIcon = targetIcon?.Icon
  const hasSavedOutput = Boolean(item.outputTruncated && item.outputPath)
  const outputIcon = item.outputPath ? fileIconForPath(item.outputPath) : null
  const OutputFileIcon = outputIcon?.Icon
  const argsCollapsedByPreview = item.argsJson ? isToolArgsPreviewTruncated(item.argsJson) : false
  const argsText = item.argsJson
    ? showFullArgs
      ? item.argsJson
      : toolArgsPreviewText(item.argsJson)
    : ''
  const outputCollapsedByPreview = item.output
    ? !hasSavedOutput &&
      isOutputPreviewTruncated({
        output: item.output,
        outputPath: item.outputPath,
        outputTruncated: item.outputTruncated
      })
    : false
  const outputPreview = item.output
    ? showFullOutput && outputCollapsedByPreview
      ? item.output
      : outputPreviewText({
          output: item.output,
          outputPath: item.outputPath,
          outputTruncated: item.outputTruncated
        })
    : ''

  return (
    <TimelineRail sx={{ py: 1 }}>
      {item.notebook ? <NotebookToolSummaryBlock notebook={item.notebook} /> : null}
      {item.toolName === 'db_query' && item.output ? (
        <DbQueryResultPreview output={item.output} />
      ) : null}
      {target ? (
        <Box
          sx={{
            mb: 1.25,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            minWidth: 0,
            flexWrap: 'wrap'
          }}
        >
          {TargetFileIcon && targetIcon ? (
            <TargetFileIcon sx={{ color: targetIcon.color, fontSize: 22 }} />
          ) : null}
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              目标文件
            </Typography>
            <Typography
              variant="caption"
              component="div"
              sx={{
                mt: 0.25,
                minWidth: 0,
                fontFamily: 'var(--font-mono)',
                color: 'text.secondary',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
              title={target.absolutePath}
            >
              {target.label}
            </Typography>
          </Box>
          <Button
            size="small"
            variant="outlined"
            onClick={() => {
              void window.api.revealPath(target.absolutePath).catch((error) => {
                console.error('Failed to reveal tool target:', error)
              })
            }}
          >
            在文件夹显示
          </Button>
        </Box>
      ) : null}
      {hasSavedOutput ? (
        <Box
          sx={{
            mb: 1.25,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            minWidth: 0,
            flexWrap: 'wrap'
          }}
        >
          {OutputFileIcon && outputIcon ? (
            <OutputFileIcon sx={{ color: outputIcon.color, fontSize: 22 }} />
          ) : null}
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              完整输出已保存
            </Typography>
            <Typography
              variant="caption"
              component="div"
              sx={{
                mt: 0.25,
                minWidth: 0,
                fontFamily: 'var(--font-mono)',
                color: 'text.secondary',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
              title={item.outputPath}
            >
              {item.outputPath}
            </Typography>
          </Box>
          <Button
            size="small"
            variant="outlined"
            onClick={() => {
              void window.api.revealPath(item.outputPath as string).catch((error) => {
                console.error('Failed to reveal tool output:', error)
              })
            }}
          >
            在文件夹显示
          </Button>
        </Box>
      ) : null}
      {item.argsJson ? (
        <Box sx={{ mb: item.output ? 1.5 : 0, minWidth: 0 }}>
          <Box
            sx={{
              mb: 0.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 1,
              minWidth: 0
            }}
          >
            <Typography
              variant="caption"
              component="div"
              sx={{ color: 'text.secondary', fontWeight: 600, minWidth: 0 }}
            >
              参数{argsCollapsedByPreview && !showFullArgs ? ' · 已折叠' : ''}
            </Typography>
            {argsCollapsedByPreview ? (
              <Button
                size="small"
                variant="text"
                onClick={() => setShowFullArgs((value) => !value)}
              >
                {showFullArgs ? '收起参数' : '显示完整参数'}
              </Button>
            ) : null}
          </Box>
          <Typography
            component="pre"
            variant="body2"
            sx={{
              m: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8rem',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              color: 'text.secondary'
            }}
          >
            {argsText}
          </Typography>
        </Box>
      ) : null}
      {item.argsJson && item.output ? <Divider sx={{ my: 1.25 }} /> : null}
      {outputPreview ? (
        <Box sx={{ minWidth: 0 }}>
          <Box
            sx={{
              mb: 0.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 1,
              minWidth: 0
            }}
          >
            <Typography
              variant="caption"
              component="div"
              sx={{ color: 'text.secondary', fontWeight: 600, minWidth: 0 }}
            >
              {hasSavedOutput ? '输出预览' : '输出'}
              {item.outputBytes ? ` · ${formatBytes(item.outputBytes)}` : ''}
              {item.outputTruncated ? ' · 已截断' : ''}
              {outputCollapsedByPreview && !showFullOutput ? ' · 已折叠' : ''}
            </Typography>
            {outputCollapsedByPreview ? (
              <Button
                size="small"
                variant="text"
                onClick={() => setShowFullOutput((value) => !value)}
              >
                {showFullOutput ? '收起输出' : '显示完整输出'}
              </Button>
            ) : null}
          </Box>
          <DiffAwareOutput text={outputPreview} cwd={cwd} />
        </Box>
      ) : null}
    </TimelineRail>
  )
}
