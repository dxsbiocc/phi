import { chatCopy } from '../../features/chat/lib/chatCopy'
import { useUiLanguage } from '../../lib/i18n'
import { Box, Button, Divider, Typography } from '@mui/material'
import { useState, type ReactNode } from 'react'
import { fileIconForPath } from '../../icons'
import type { ToolCallItem } from '../../types'
import { webToolSummary } from '../../features/chat/lib/webToolSummary'
import { toolTargetFromArgs } from '../../lib/toolTargets'
import { remotePathInsideRoot, remoteWorkspaceUri } from '../../../../shared/remoteWorkspacePath'
import { useRemoteProjectFileContext } from '../../lib/remoteProjectFileContext'
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
  useUiLanguage()
  const remoteProject = useRemoteProjectFileContext()
  const [showFullArgs, setShowFullArgs] = useState(false)
  const [showFullOutput, setShowFullOutput] = useState(false)
  const webSummary = webToolSummary(item.toolName, item.argsJson)
  const target = toolTargetFromArgs(item.toolName, item.argsJson, cwd ?? '', {
    allowBareFileName: Boolean(remoteProject)
  })
  const remoteTargetUri =
    target &&
    remoteProject?.hostAlias &&
    remotePathInsideRoot(target.absolutePath, remoteProject.canonicalRoot)
      ? remoteWorkspaceUri(remoteProject.hostAlias, target.absolutePath)
      : null
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
      {webSummary?.query ? (
        <Box sx={{ mb: 1.25, minWidth: 0 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
            {chatCopy.searchTerms}
          </Typography>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {webSummary.query}
          </Typography>
        </Box>
      ) : null}
      {item.notebook ? <NotebookToolSummaryBlock notebook={item.notebook} /> : null}
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
              {chatCopy.targetFile}
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
              title={remoteTargetUri ?? target.absolutePath}
            >
              {remoteProject?.hostAlias
                ? `${remoteProject.hostAlias} · ${target.label}`
                : target.label}
            </Typography>
          </Box>
          {remoteProject ? (
            remoteTargetUri ? (
              <Button
                size="small"
                variant="outlined"
                onClick={() => remoteProject.openPath(remoteTargetUri, 'file')}
              >
                {chatCopy.openInFilePanel}
              </Button>
            ) : null
          ) : (
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                void window.api.revealPath(target.absolutePath).catch((error) => {
                  console.error('Failed to reveal tool target:', error)
                })
              }}
            >
              {chatCopy.revealInFolder}
            </Button>
          )}
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
              {chatCopy.fullOutputSaved}
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
            {chatCopy.revealInFolder}
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
              {chatCopy.arguments}
              {argsCollapsedByPreview && !showFullArgs ? chatCopy.collapsed : ''}
            </Typography>
            {argsCollapsedByPreview ? (
              <Button
                size="small"
                variant="text"
                onClick={() => setShowFullArgs((value) => !value)}
              >
                {showFullArgs ? chatCopy.collapseArguments : chatCopy.showFullArguments}
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
              {hasSavedOutput ? chatCopy.outputPreview : chatCopy.output}
              {item.outputBytes ? ` · ${formatBytes(item.outputBytes)}` : ''}
              {item.outputTruncated ? chatCopy.truncated : ''}
              {outputCollapsedByPreview && !showFullOutput ? chatCopy.collapsed : ''}
            </Typography>
            {outputCollapsedByPreview ? (
              <Button
                size="small"
                variant="text"
                onClick={() => setShowFullOutput((value) => !value)}
              >
                {showFullOutput ? chatCopy.collapseOutput : chatCopy.showFullOutput}
              </Button>
            ) : null}
          </Box>
          <DiffAwareOutput text={outputPreview} cwd={cwd} />
        </Box>
      ) : null}
    </TimelineRail>
  )
}
