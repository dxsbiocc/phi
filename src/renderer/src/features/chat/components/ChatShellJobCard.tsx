import { Box, Button, Stack, Typography } from '@mui/material'
import { useState } from 'react'
import { NoticeRow } from '../../../components/chat/NoticeRow'
import type { ChatContentResizeHandler } from '../../../components/chat/useCollapseResizeNotifier'
import { useUiLanguage } from '../../../lib/i18n'
import { chatCodeCopy } from '../lib/chatCodeCopy'
import { chatCopy } from '../lib/chatCopy'
import type { ChatShellJob } from '../lib/chatShellTimeline'

const titleKeys = {
  queued: 'shellQueued',
  running: 'shellRunning',
  completed: 'shellCompleted',
  failed: 'shellFailed',
  cancelled: 'shellCancelled',
  interrupted: 'shellInterrupted'
} as const satisfies Record<ChatShellJob['state'], keyof typeof chatCodeCopy>

const codeSx = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.8rem',
  m: 0,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  maxHeight: 240,
  overflow: 'auto'
} as const

function ChatShellOutput({ job }: { job: ChatShellJob }): React.JSX.Element {
  useUiLanguage()
  const [output, setOutput] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const loadOutput = async (): Promise<void> => {
    if (!job.outputPath || loading) return
    setLoading(true)
    setFailed(false)
    try {
      const file = await window.api.previewFile(job.outputPath)
      if (file.kind !== 'text') throw new Error('Expected a text log')
      setOutput(file.content)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Stack spacing={0.75}>
      <Box component="pre" sx={codeSx}>
        {job.command}
      </Box>
      {output || job.output ? (
        <Box component="pre" sx={codeSx}>
          {output ?? job.output}
        </Box>
      ) : null}
      {job.outputTruncated ? (
        <Typography variant="caption" color="text.secondary">
          {chatCodeCopy.outputTruncated}
        </Typography>
      ) : null}
      {job.outputPath && output === undefined ? (
        <Button
          size="small"
          sx={{ alignSelf: 'start', textTransform: 'none' }}
          onClick={() => void loadOutput()}
          disabled={loading}
        >
          {loading ? chatCodeCopy.loadingOutput : chatCodeCopy.showOutput}
        </Button>
      ) : null}
      {failed ? (
        <Typography variant="body2" role="alert">
          {chatCodeCopy.outputUnavailable}
        </Typography>
      ) : null}
    </Stack>
  )
}

export function ChatShellJobCard({
  job,
  onOpenBackgroundJobs,
  onContentResize
}: {
  job: ChatShellJob
  onOpenBackgroundJobs: () => void
  onContentResize?: ChatContentResizeHandler
}): React.JSX.Element {
  useUiLanguage()
  return (
    <NoticeRow
      level={job.state === 'failed' ? 'error' : job.state === 'interrupted' ? 'warning' : 'info'}
      title={chatCodeCopy[titleKeys[job.state]]}
      detail={job.exitCode === undefined ? job.command : chatCodeCopy.exitCode(job.exitCode)}
      onContentResize={onContentResize}
      action={
        <Button size="small" onClick={onOpenBackgroundJobs} sx={{ textTransform: 'none' }}>
          {chatCopy.viewBackgroundJobs}
        </Button>
      }
    >
      <ChatShellOutput job={job} />
    </NoticeRow>
  )
}
