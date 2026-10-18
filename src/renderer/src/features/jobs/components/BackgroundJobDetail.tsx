import { jobsCopy } from '../lib/jobsCopy'
import { getUiLocale, useUiLanguage } from '../../../lib/i18n'
import { Box, Button, Stack, Typography } from '@mui/material'
import { useEffect, useRef, useState } from 'react'

import type { RemoteJupyterStartJob } from '../../../../../shared/remoteJupyterJobTypes'
import { workspacePanelText } from '../../../layout'
import type { UnifiedBackgroundJob } from '../lib/backgroundJobs'
import {
  canStopJob,
  jobDetailFields,
  jobStatus,
  jobTitle,
  stopTooltip,
  JOB_TONE_COLOR
} from '../lib/backgroundJobLabels'
import { buildConnectorJobDetailText } from '../lib/connectorJobDetails'
import { ConnectorJobDetailBody } from './ConnectorJobDetailDialog'
import { JobDetailField } from './JobDetailField'
import { NotebookJobPreview } from './NotebookJobPreview'
import { NotebookJobActivity } from './NotebookJobActivity'

function entryTime(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(getUiLocale())
}

function JupyterStartLog({ job }: { job: RemoteJupyterStartJob }): React.JSX.Element {
  useUiLanguage()
  const endRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [job.entries.length])
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ ...workspacePanelText.label, display: 'block', mb: 0.35 }}
      >
        {jobsCopy.startupLog}
      </Typography>
      <Box
        data-phi-jupyter-start-log
        sx={{
          maxHeight: 320,
          overflowY: 'auto',
          p: 1,
          borderRadius: 1,
          bgcolor: 'action.hover',
          fontFamily: 'var(--font-mono)',
          fontSize: workspacePanelText.body.fontSize,
          lineHeight: workspacePanelText.body.lineHeight,
          userSelect: 'text'
        }}
      >
        {job.entries.length === 0 ? (
          <Typography variant="caption" color="text.secondary" sx={workspacePanelText.body}>
            {jobsCopy.noLogsYet}
          </Typography>
        ) : (
          job.entries.map((entry, index) => (
            <Box
              key={`${entry.at}:${index}`}
              sx={{
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                color:
                  entry.kind === 'error'
                    ? 'error.main'
                    : entry.kind === 'output'
                      ? 'text.secondary'
                      : 'text.primary',
                fontWeight: entry.kind === 'step' ? 600 : 400
              }}
            >
              <Box component="span" sx={{ color: 'text.disabled', mr: 0.75 }}>
                {entryTime(entry.at)}
              </Box>
              {entry.kind === 'output' ? '  ' : ''}
              {entry.text}
            </Box>
          ))
        )}
        <div ref={endRef} />
      </Box>
    </Box>
  )
}

function detailText(item: UnifiedBackgroundJob, nowMs: number): string {
  if (item.kind === 'connector') return buildConnectorJobDetailText(item.setup, nowMs)
  const lines = [
    jobTitle(item),
    ...jobDetailFields(item, nowMs).map((field) => `${field.label}：${field.value}`)
  ]
  if (item.kind === 'jupyter') {
    lines.push(
      '',
      jobsCopy.startupLog2,
      ...item.job.entries.map((entry) => `${entry.at} [${entry.kind}] ${entry.text}`)
    )
  }
  if (item.kind === 'notebook-ai' && item.job.entries?.length) {
    lines.push(
      '',
      jobsCopy.runActivity,
      ...item.job.entries.map(
        (entry) =>
          `${entry.at} [${entry.kind}${entry.label ? `:${entry.label}` : ''}] ${entry.text}`
      )
    )
  }
  return lines.join('\n')
}

/** A job's full detail, shown in place of the list so the main view stays where it was. */
export function BackgroundJobDetail({
  item,
  nowMs,
  busy,
  onBack,
  onStop,
  onRetry,
  onOpenSession,
  onOpenWrapper,
  onOpenSetupAgent,
  onOpenSetupTerminal
}: {
  item: UnifiedBackgroundJob
  nowMs: number
  busy: boolean
  onBack: () => void
  onStop: (item: UnifiedBackgroundJob) => void
  onRetry?: (item: UnifiedBackgroundJob) => void
  onOpenSession: (path: string) => void
  onOpenWrapper?: (canonicalId: string) => void
  onOpenSetupAgent?: (prompt: string) => void
  onOpenSetupTerminal?: (command: string) => void
}): React.JSX.Element {
  useUiLanguage()
  const [copied, setCopied] = useState(false)
  const status = jobStatus(item)
  const title = jobTitle(item)
  const sessionPath =
    item.kind === 'agent' || item.kind === 'shell'
      ? item.run.sessionPath
      : item.kind === 'history'
        ? item.snapshot.sessionPath
        : undefined
  const wrapperId =
    item.kind === 'wrapper'
      ? item.run.wrapper.canonicalId
      : item.kind === 'history'
        ? item.snapshot.wrapperId
        : undefined

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(detailText(item, nowMs))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Box
      data-phi-background-job-detail={item.key}
      sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1, p: 1.5 }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1, minWidth: 0 }}>
        <Button
          size="small"
          onClick={onBack}
          aria-label={jobsCopy.backToJobList}
          sx={{ flexShrink: 0 }}
        >
          {jobsCopy.back}
        </Button>
        <Typography
          variant="caption"
          sx={{
            ...workspacePanelText.body,
            flex: 1,
            textAlign: 'right',
            color: JOB_TONE_COLOR[status.tone]
          }}
        >
          {status.label}
        </Typography>
      </Stack>
      <Typography
        variant="subtitle2"
        sx={{ ...workspacePanelText.heading, overflowWrap: 'anywhere', mb: 1 }}
      >
        {title}
      </Typography>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        {item.kind === 'connector' ? (
          <ConnectorJobDetailBody
            setup={item.setup}
            nowMs={nowMs}
            retrying={busy}
            onRetry={() => onRetry?.(item)}
            onOpenSetupAgent={onOpenSetupAgent}
            onCopySetupCommand={(command) => {
              void navigator.clipboard.writeText(command).catch(() => undefined)
            }}
            onOpenSetupTerminal={onOpenSetupTerminal}
          />
        ) : (
          <Stack spacing={1.25}>
            {item.kind === 'notebook-ai' && (
              <NotebookJobActivity key={item.job.id} job={item.job} />
            )}
            {jobDetailFields(item, nowMs).map((field) =>
              item.kind === 'notebook-ai' && field.label === jobsCopy.generatedContentPreview ? (
                <NotebookJobPreview key={field.label} job={item.job} />
              ) : (
                <JobDetailField key={field.label} {...field} />
              )
            )}
            {item.kind === 'jupyter' && <JupyterStartLog job={item.job} />}
          </Stack>
        )}
      </Box>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: 'divider', flexWrap: 'wrap' }}
      >
        <Button size="small" onClick={() => void copy().catch(() => undefined)}>
          {copied ? jobsCopy.copied : jobsCopy.copyDetails}
        </Button>
        {sessionPath && (
          <Button size="small" onClick={() => onOpenSession(sessionPath)}>
            {jobsCopy.openConversation}
          </Button>
        )}
        {wrapperId && onOpenWrapper && (
          <Button size="small" onClick={() => onOpenWrapper(wrapperId)}>
            {jobsCopy.openWrapper}
          </Button>
        )}
        {onRetry && item.kind !== 'connector' && item.kind !== 'history' && (
          <Button size="small" disabled={busy} onClick={() => onRetry(item)}>
            {jobsCopy.retry}
          </Button>
        )}
        {canStopJob(item) && (
          <Button size="small" color="error" disabled={busy} onClick={() => onStop(item)}>
            {stopTooltip(item)}
          </Button>
        )}
      </Stack>
    </Box>
  )
}
