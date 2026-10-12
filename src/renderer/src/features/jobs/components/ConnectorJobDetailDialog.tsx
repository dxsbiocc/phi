import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack } from '@mui/material'
import { useEffect, useState } from 'react'

import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import { connectorJobDuration, connectorJobStatusLabel } from '../lib/backgroundJobs'
import {
  buildConnectorJobDetailText,
  connectorJobStartedAtLabel,
  connectorJobToolsLabel
} from '../lib/connectorJobDetails'
import { ConnectorJobSetupGuide } from './ConnectorJobSetupGuide'
import { JobDetailField as DetailField } from './JobDetailField'

type DetailContentProps = {
  setup: McpConnectorSetupProgress
  nowMs: number
  copied: boolean
  retrying?: boolean
  onCopy: () => void
  onRetry: () => void
  onClose: () => void
  onOpenSetupAgent?: (prompt: string) => void
  onCopySetupCommand?: (command: string) => void
  onOpenSetupTerminal?: (command: string) => void
}

/** The connector's fields and setup guide, without dialog chrome; also used in the jobs panel. */
export function ConnectorJobDetailBody({
  setup,
  nowMs,
  retrying = false,
  onRetry,
  onOpenSetupAgent = () => undefined,
  onCopySetupCommand = () => undefined,
  onOpenSetupTerminal = () => undefined
}: Pick<
  DetailContentProps,
  | 'setup'
  | 'nowMs'
  | 'retrying'
  | 'onRetry'
  | 'onOpenSetupAgent'
  | 'onCopySetupCommand'
  | 'onOpenSetupTerminal'
>): React.JSX.Element {
  return (
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
      {setup.phase === 'failed' && setup.error !== '已取消' ? (
        <ConnectorJobSetupGuide
          setup={setup}
          retrying={retrying}
          onOpenAgent={onOpenSetupAgent}
          onCopyCommand={onCopySetupCommand}
          onOpenTerminal={onOpenSetupTerminal}
          onRetry={onRetry}
        />
      ) : null}
    </Stack>
  )
}

export function ConnectorJobDetailContent({
  setup,
  nowMs,
  copied,
  retrying = false,
  onCopy,
  onRetry,
  onClose,
  onOpenSetupAgent = () => undefined,
  onCopySetupCommand = () => undefined,
  onOpenSetupTerminal = () => undefined
}: DetailContentProps): React.JSX.Element {
  return (
    <>
      <DialogTitle>连接器详情</DialogTitle>
      <DialogContent>
        <ConnectorJobDetailBody
          setup={setup}
          nowMs={nowMs}
          retrying={retrying}
          onRetry={onRetry}
          onOpenSetupAgent={onOpenSetupAgent}
          onCopySetupCommand={onCopySetupCommand}
          onOpenSetupTerminal={onOpenSetupTerminal}
        />
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
  onClose,
  onOpenSetupAgent,
  onOpenSetupTerminal
}: {
  open: boolean
  setup: McpConnectorSetupProgress
  retrying?: boolean
  nowMs?: number
  onRetry: () => void
  onClose: () => void
  onOpenSetupAgent?: (prompt: string) => void
  onOpenSetupTerminal?: (command: string) => void
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
        onOpenSetupAgent={onOpenSetupAgent}
        onCopySetupCommand={(command) => {
          void navigator.clipboard.writeText(command).catch(() => undefined)
        }}
        onOpenSetupTerminal={onOpenSetupTerminal}
        onClose={onClose}
      />
    </Dialog>
  )
}
