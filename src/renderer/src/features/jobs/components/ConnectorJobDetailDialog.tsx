import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'
import { useEffect, useState } from 'react'

import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import { connectorJobDuration, connectorJobStatusLabel } from '../lib/backgroundJobs'
import {
  buildConnectorJobDetailText,
  connectorJobStartedAtLabel,
  connectorJobToolsLabel
} from '../lib/connectorJobDetails'

type DetailContentProps = {
  setup: McpConnectorSetupProgress
  nowMs: number
  copied: boolean
  retrying?: boolean
  onCopy: () => void
  onRetry: () => void
  onClose: () => void
}

function DetailField({
  label,
  value,
  mono = false,
  scroll = false
}: {
  label: string
  value: string
  mono?: boolean
  scroll?: boolean
}): React.JSX.Element {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.35 }}>
        {label}
      </Typography>
      <Typography
        component={mono ? 'pre' : 'div'}
        variant="body2"
        sx={{
          m: 0,
          minWidth: 0,
          maxHeight: scroll ? 240 : undefined,
          overflowY: scroll ? 'auto' : undefined,
          overflowWrap: 'anywhere',
          whiteSpace: mono ? 'pre-wrap' : 'normal',
          fontFamily: mono ? 'var(--font-mono)' : undefined,
          userSelect: 'text'
        }}
      >
        {value}
      </Typography>
    </Box>
  )
}

export function ConnectorJobDetailContent({
  setup,
  nowMs,
  copied,
  retrying = false,
  onCopy,
  onRetry,
  onClose
}: DetailContentProps): React.JSX.Element {
  return (
    <>
      <DialogTitle>连接器详情</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <DetailField label="连接器名称" value={setup.title ?? setup.id} />
          <DetailField label="状态" value={connectorJobStatusLabel(setup)} />
          <DetailField label="命令" value={setup.summary ?? setup.id} mono />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <DetailField label="开始时间" value={connectorJobStartedAtLabel(setup)} />
            <DetailField label="耗时" value={connectorJobDuration(setup, nowMs)} />
          </Stack>
          <DetailField label="错误" value={setup.error ?? '没有错误'} mono />
          <DetailField label="进程输出" value={setup.detail ?? '没有进程输出'} mono scroll />
          {setup.phase === 'ready' ? (
            <DetailField label="工具列表" value={connectorJobToolsLabel(setup)} />
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCopy}>{copied ? '已复制' : '复制详情'}</Button>
        {setup.phase === 'failed' ? (
          <Button disabled={retrying} onClick={onRetry}>
            重试
          </Button>
        ) : null}
        <Button variant="contained" onClick={onClose}>
          关闭
        </Button>
      </DialogActions>
    </>
  )
}

export function ConnectorJobDetailDialog({
  open,
  setup,
  retrying = false,
  nowMs,
  onRetry,
  onClose
}: {
  open: boolean
  setup: McpConnectorSetupProgress
  retrying?: boolean
  nowMs?: number
  onRetry: () => void
  onClose: () => void
}): React.JSX.Element {
  const [liveNowMs, setLiveNowMs] = useState(() => nowMs ?? Date.now())
  const [copied, setCopied] = useState(false)
  const displayNowMs = nowMs ?? liveNowMs

  useEffect(() => {
    if (!open || setup.phase !== 'starting' || nowMs !== undefined) return undefined
    const timer = window.setInterval(() => setLiveNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [nowMs, open, setup.phase])

  const copyDetails = async (): Promise<void> => {
    await navigator.clipboard.writeText(buildConnectorJobDetailText(setup, displayNowMs))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <ConnectorJobDetailContent
        setup={setup}
        nowMs={displayNowMs}
        copied={copied}
        retrying={retrying}
        onCopy={() => void copyDetails().catch(() => undefined)}
        onRetry={onRetry}
        onClose={onClose}
      />
    </Dialog>
  )
}
