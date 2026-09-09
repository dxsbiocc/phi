import { Box, Button, CircularProgress, Collapse, Divider, Typography } from '@mui/material'
import { useState, type ReactNode } from 'react'
import { PhiIcons, fileIconForPath } from '../icons'
import type { ToolCallItem } from '../types'
import { tokenizeLocalPaths } from '../lib/localPaths'
import { toolActionKind } from '../lib/toolActions'
import { toolTargetFromArgs } from '../lib/toolTargets'
import { diffStat } from '../lib/toolOutput'
import {
  formatBytes,
  isOutputPreviewTruncated,
  isToolArgsPreviewTruncated,
  outputPreviewText,
  toolArgsPreviewText
} from '../lib/toolOutputPresentation'
import { ToolActionIcon } from './ToolActionIcon'

const CancelIcon = PhiIcons.state.denied
const CheckCircleIcon = PhiIcons.state.done
const ChevronRightIcon = PhiIcons.action.back

function LocalPathOutputButton({
  text,
  absolutePath
}: {
  text: string
  absolutePath: string
}): React.JSX.Element {
  return (
    <Box
      component="button"
      type="button"
      title={absolutePath}
      onClick={() => {
        void window.api.revealPath(absolutePath).catch((error) => {
          console.error('Failed to reveal tool output path:', error)
        })
      }}
      sx={{
        display: 'inline',
        p: 0,
        m: 0,
        border: 0,
        bgcolor: 'transparent',
        color: 'primary.light',
        font: 'inherit',
        fontFamily: 'inherit',
        textDecoration: 'underline',
        textDecorationThickness: '1px',
        textUnderlineOffset: '2px',
        cursor: 'pointer',
        overflowWrap: 'anywhere',
        '&:hover': { color: 'primary.main' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', borderRadius: 0.5 }
      }}
    >
      {text}
    </Box>
  )
}

function LocalPathOutputText({ text, cwd }: { text: string; cwd?: string }): ReactNode {
  return tokenizeLocalPaths(text, cwd ?? '').map((token, index) =>
    token.kind === 'path' ? (
      <LocalPathOutputButton
        key={`${token.absolutePath}-${index}`}
        text={token.text}
        absolutePath={token.absolutePath}
      />
    ) : (
      <span key={index}>{token.text}</span>
    )
  )
}

function DiffAwareOutput({ text, cwd }: { text: string; cwd?: string }): ReactNode {
  const lines = text.split('\n')
  const looksLikeDiff = lines.some((line) => /^[+-]{1}[^+-]/.test(line) || /^@@ /.test(line))

  if (!looksLikeDiff) {
    return (
      <Typography
        component="pre"
        variant="body2"
        sx={{
          m: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8rem',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere'
        }}
      >
        <LocalPathOutputText text={text} cwd={cwd} />
      </Typography>
    )
  }

  return (
    <Box component="pre" sx={{ m: 0, fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
      {lines.map((line, index) => {
        const color = line.startsWith('+')
          ? 'success.main'
          : line.startsWith('-')
            ? 'error.main'
            : line.startsWith('@@')
              ? 'info.main'
              : 'text.secondary'
        return (
          <Typography
            key={index}
            component="div"
            variant="body2"
            sx={{
              fontFamily: 'inherit',
              fontSize: 'inherit',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              color
            }}
          >
            {line || ' '}
          </Typography>
        )
      })}
    </Box>
  )
}

export function StatusIndicator({ status }: { status: ToolCallItem['status'] }): ReactNode {
  if (status === 'running') {
    return (
      <CircularProgress
        size={14}
        thickness={5}
        color="inherit"
        sx={{
          color: 'text.secondary',
          '@media (prefers-reduced-motion: reduce)': {
            animation: 'none'
          }
        }}
        aria-label="执行中"
      />
    )
  }
  if (status === 'error') {
    return <CancelIcon sx={{ fontSize: 14 }} color="error" aria-label="失败" />
  }
  return <CheckCircleIcon sx={{ fontSize: 14, color: 'success.main' }} aria-label="完成" />
}

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
    <Box
      sx={{
        ml: 2.5,
        pl: 1.5,
        py: 1,
        minWidth: 0,
        borderLeft: 2,
        borderColor: 'grey.800'
      }}
    >
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
    </Box>
  )
}

function foldedToolHeadline(item: ToolCallItem, action: ReturnType<typeof toolActionKind>): string {
  if (action === 'python') return '执行 Python 代码'
  if (action === 'command') return '执行命令'
  return item.argsPreview || item.toolName
}

function ToolCallCard({ item, cwd }: { item: ToolCallItem; cwd?: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const stat = item.output ? diffStat(item.output) : null
  const toggle = (): void => setExpanded((value) => !value)
  const action = toolActionKind(item.toolName, item.argsPreview, item.argsJson)
  const headline = foldedToolHeadline(item, action)
  const showToolName = action !== 'command' && action !== 'python'

  return (
    <Box sx={{ alignSelf: 'stretch', minWidth: 0 }}>
      <Box
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggle()
          }
        }}
        aria-expanded={expanded}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          minWidth: 0,
          py: 0.5,
          px: 0.5,
          borderRadius: 1,
          cursor: 'pointer',
          color: 'text.secondary',
          transition: 'background-color 150ms',
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        <ChevronRightIcon
          sx={{
            fontSize: 16,
            flexShrink: 0,
            transition: 'transform 150ms',
            transform: expanded ? 'rotate(90deg)' : 'none'
          }}
        />
        <ToolActionIcon action={action} />
        {showToolName ? (
          <Typography
            component="span"
            variant="body2"
            sx={{ fontFamily: 'var(--font-mono)', color: 'text.primary', flexShrink: 0 }}
          >
            {item.toolName}
          </Typography>
        ) : null}
        <Typography
          component="span"
          variant="body2"
          noWrap
          sx={{
            fontFamily: showToolName ? 'var(--font-mono)' : 'inherit',
            flex: 1,
            minWidth: 0
          }}
        >
          {headline}
        </Typography>
        {stat ? (
          <Typography
            component="span"
            variant="caption"
            sx={{ flexShrink: 0, fontFamily: 'var(--font-mono)' }}
          >
            {stat.added ? (
              <Box component="span" sx={{ color: 'success.main' }}>
                +{stat.added}{' '}
              </Box>
            ) : null}
            {stat.removed ? (
              <Box component="span" sx={{ color: 'error.main' }}>
                -{stat.removed}
              </Box>
            ) : null}
          </Typography>
        ) : null}
        <Box
          aria-live={item.status === 'running' ? 'polite' : undefined}
          sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}
        >
          <StatusIndicator status={item.status} />
        </Box>
      </Box>
      <Collapse in={expanded} unmountOnExit>
        <ToolCallDetail item={item} cwd={cwd} />
      </Collapse>
    </Box>
  )
}

export default ToolCallCard
