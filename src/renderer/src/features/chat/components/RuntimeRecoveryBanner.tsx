import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Select,
  Stack,
  Typography
} from '@mui/material'
import { useState } from 'react'
import type {
  RuntimeRecoveryApi,
  RuntimeRecoveryState,
  RuntimeRecoveryTarget,
  RuntimeSummaryContinuation
} from '../../../../../shared/runtimeRecoveryTypes'
import { useRuntimeRecovery } from '../hooks/useRuntimeRecovery'
import { runtimeRecoveryViewKey, selectedRecoveryModel } from '../lib/runtimeRecoveryState'

export function RuntimeRecoveryBanner({
  api,
  target,
  models = [],
  onRecovered,
  onSummaryCreated
}: {
  api: RuntimeRecoveryApi
  target: RuntimeRecoveryTarget | null
  models?: readonly { providerId: string; modelId: string; name?: string }[]
  onRecovered?: (state: RuntimeRecoveryState) => void | Promise<void>
  onSummaryCreated?: (result: RuntimeSummaryContinuation) => void | Promise<void>
}): React.JSX.Element | null {
  const recovery = useRuntimeRecovery(api, target, onRecovered, onSummaryCreated)
  const viewKey = runtimeRecoveryViewKey(target)
  const [selection, setSelection] = useState({ viewKey: '', summaryOpen: false, replacement: '' })
  const summaryOpen = selection.viewKey === viewKey && selection.summaryOpen
  const replacement = selection.viewKey === viewKey ? selection.replacement : ''
  const updateSelection = (patch: Partial<typeof selection>): void =>
    setSelection({ viewKey, summaryOpen, replacement, ...patch })
  const state = recovery.state
  if (!state)
    return recovery.error ? (
      <Alert
        severity="warning"
        action={<Button onClick={() => void recovery.refresh()}>刷新状态</Button>}
        sx={{ mx: 2, my: 1 }}
      >
        {recovery.error}
      </Alert>
    ) : null
  if (state.phase === 'not-started') return null
  if (state.phase === 'connected')
    return recovery.error ? (
      <Alert severity="warning" sx={{ mx: 2, my: 1 }}>
        <Typography variant="body2">会话已连接，请重新打开此会话刷新内容。</Typography>
        <Typography variant="caption">{recovery.error}</Typography>
      </Alert>
    ) : null
  const busy = recovery.pending || state.phase === 'busy'
  const chosen = selectedRecoveryModel(replacement, models)
  const needsModel = state.issue === 'model-unavailable'
  return (
    <>
      <Alert
        severity={
          state.issue === 'journal-invalid' || state.issue === 'binding-changed'
            ? 'error'
            : 'warning'
        }
        variant="outlined"
        sx={{ mx: 2, my: 1, flexShrink: 0 }}
      >
        <Stack spacing={1}>
          <Typography variant="body2">{state.message}</Typography>
          {recovery.error ? (
            <Typography variant="caption" color="error">
              {recovery.error}
            </Typography>
          ) : null}
          {needsModel ? (
            <Select
              size="small"
              value={replacement}
              displayEmpty
              disabled={busy}
              inputProps={{ 'aria-label': '选择替代模型' }}
              onChange={(event) => updateSelection({ replacement: event.target.value })}
            >
              <MenuItem value="" disabled>
                选择可用的替代模型
              </MenuItem>
              {models.map((model) => (
                <MenuItem
                  key={JSON.stringify([model.providerId, model.modelId])}
                  value={JSON.stringify([model.providerId, model.modelId])}
                >
                  {model.name ?? model.modelId} · {model.providerId}
                </MenuItem>
              ))}
            </Select>
          ) : null}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            {busy ? <CircularProgress size={14} /> : null}
            <Button
              size="small"
              disabled={busy || !state.canResume || (needsModel && !chosen)}
              onClick={() => void recovery.resume(chosen)}
            >
              恢复原会话
            </Button>
            {state.summary ? (
              <Button
                size="small"
                disabled={busy}
                onClick={() => updateSelection({ summaryOpen: true })}
              >
                查看摘要并新建
              </Button>
            ) : null}
            <Button size="small" disabled={busy} onClick={() => void recovery.refresh()}>
              刷新状态
            </Button>
          </Stack>
        </Stack>
      </Alert>
      <Dialog
        open={summaryOpen && Boolean(state.summary)}
        onClose={() => {
          if (!busy) updateSelection({ summaryOpen: false })
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>用本地摘要另建会话</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 1 }}>
            旧会话会保留。新会话不会自动发送消息或重新启动任务；服务器离线时仍未连接。
          </Typography>
          <Box
            component="pre"
            sx={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              maxHeight: 320,
              overflow: 'auto',
              font: 'inherit',
              bgcolor: 'action.hover',
              p: 1.5,
              borderRadius: 1
            }}
          >
            {state.summary?.content}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => updateSelection({ summaryOpen: false })}>
            取消
          </Button>
          <Button
            disabled={busy || state.canContinueFromSummary === false}
            onClick={() => void recovery.continueFromSummary()}
          >
            用此摘要新建会话
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
