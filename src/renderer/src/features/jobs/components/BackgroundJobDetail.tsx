import { jobsCopy } from '../lib/jobsCopy'
import { getUiLocale, useUiLanguage } from '../../../lib/i18n'
import { Box, Button, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { useEffect, useRef, useState } from 'react'

import type { RemoteJupyterStartJob } from '../../../../../shared/remoteJupyterJobTypes'
import { PhiIcons } from '../../../icons'
import { LabeledIconButton } from '../../../components/LabeledIconButton'
import { workspacePanelText } from '../../../layout'
import type { UnifiedBackgroundJob } from '../lib/backgroundJobs'
import {
  canStopJob,
  jobDetailFields,
  jobStatus,
  jobOperation,
  jobTitle,
  remoteJupyterEntryLabel,
  stopTooltip,
  JOB_TONE_COLOR
} from '../lib/backgroundJobLabels'
import { buildConnectorJobDetailText } from '../lib/connectorJobDetails'
import { ConnectorJobDetailBody } from './ConnectorJobDetailDialog'
import { JobDetailField } from './JobDetailField'
import { NotebookJobPreview } from './NotebookJobPreview'
import { NotebookJobActivity } from './NotebookJobActivity'
import { scrollJupyterLogToEnd } from '../lib/jupyterLogScroll'

function entryTime(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(getUiLocale())
}

function JupyterStartLog({ job }: { job: RemoteJupyterStartJob }): React.JSX.Element {
  useUiLanguage()
  const viewportRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    scrollJupyterLogToEnd(viewportRef.current)
  }, [job.entries.length])
  return (
    <Box sx={{ minWidth: 0, minHeight: 180, flex: 1, display: 'flex', flexDirection: 'column' }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ ...workspacePanelText.label, display: 'block', mb: 0.35 }}
      >
        {jobsCopy.startupLog}
      </Typography>
      <Box
        ref={viewportRef}
        data-phi-jupyter-start-log
        sx={{
          maxHeight: 480,
          minHeight: 0,
          flex: 1,
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
              {remoteJupyterEntryLabel(entry)}
            </Box>
          ))
        )}
      </Box>
    </Box>
  )
}

/** The detail page stands alone, so its heading names the operation too: "安装插件 · Visualization". */
function detailHeading(item: UnifiedBackgroundJob): string {
  return `${jobOperation(item)} · ${jobTitle(item)}`
}

function detailText(item: UnifiedBackgroundJob, nowMs: number): string {
  if (item.kind === 'connector') return buildConnectorJobDetailText(item.setup, nowMs)
  const lines = [
    detailHeading(item),
    ...jobDetailFields(item, nowMs).map((field) => `${field.label}：${field.value}`)
  ]
  if (item.kind === 'jupyter') {
    lines.push(
      '',
      jobsCopy.startupLog2,
      ...item.job.entries.map(
        (entry) => `${entry.at} [${entry.kind}] ${remoteJupyterEntryLabel(entry)}`
      )
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
  const canStop = canStopJob(item)
  const title = detailHeading(item)
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
  const showFooter = Boolean(
    sessionPath ||
    (wrapperId && onOpenWrapper) ||
    (onRetry && item.kind !== 'connector' && item.kind !== 'history') ||
    canStop
  )

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
          sx={{ flexShrink: 0, minWidth: 0, pl: 0, pr: 1, justifyContent: 'flex-start' }}
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
        <Tooltip title={copied ? jobsCopy.copied : jobsCopy.copyDetails}>
          <IconButton
            size="small"
            aria-label={copied ? jobsCopy.copied : jobsCopy.copyDetails}
            onClick={() => void copy().catch(() => undefined)}
          >
            <PhiIcons.action.copy size={16} />
          </IconButton>
        </Tooltip>
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
          <Stack
            spacing={1.25}
            sx={item.kind === 'jupyter' ? { height: '100%', minHeight: 0 } : undefined}
          >
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
      {showFooter && (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: 'divider', flexWrap: 'wrap' }}
        >
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
            <LabeledIconButton
              label={jobsCopy.retry}
              size="small"
              disabled={busy}
              onClick={() => onRetry(item)}
            >
              <PhiIcons.action.refresh size={16} aria-hidden />
            </LabeledIconButton>
          )}
          {canStop && (
            <LabeledIconButton
              label={stopTooltip(item)}
              size="small"
              color="error"
              disabled={busy}
              onClick={() => onStop(item)}
            >
              <PhiIcons.action.stop size={16} aria-hidden />
            </LabeledIconButton>
          )}
        </Stack>
      )}
    </Box>
  )
}
