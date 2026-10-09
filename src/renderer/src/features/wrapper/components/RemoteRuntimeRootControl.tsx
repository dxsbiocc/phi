import { Alert, Button, Stack, TextField, Typography } from '@mui/material'

import type { ResolvedRemoteRuntimeRoot } from '../../../../../shared/remoteRuntimeRootTypes'
import type { RemoteDoctorUiState } from '../lib/remoteDoctorUi'
import {
  remoteRuntimeRootUiStatus,
  runtimeRootHasHardErrors,
  runtimeRootNeedsWarningConfirmation
} from '../lib/remoteRuntimeRootUi'
import { RemoteRuntimeRootResults } from './RemoteRuntimeRootResults'

const SOURCE_LABELS: Record<ResolvedRemoteRuntimeRoot['source'], string> = {
  project: '项目',
  host: '主机',
  default: '默认'
}

export interface RemoteRuntimeRootControlProps {
  label: string
  value: string
  effective: ResolvedRemoteRuntimeRoot
  doctorState: RemoteDoctorUiState
  doctorTargetKey: string
  busy: boolean
  onChange: (value: string) => void
  onCheck: () => void
  onConfirmWarnings?: () => void
  onSave?: () => void
  onClear?: () => void
  valueError?: string | null
}

function RuntimeRootActions({
  busy,
  hardBlocked,
  checkBlocked,
  needsConfirmation,
  onCheck,
  onSave,
  onClear
}: Pick<RemoteRuntimeRootControlProps, 'busy' | 'onCheck' | 'onSave' | 'onClear'> & {
  hardBlocked: boolean
  checkBlocked: boolean
  needsConfirmation: boolean
}): React.JSX.Element {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      {onSave && !needsConfirmation && (
        <Button size="small" variant="contained" disabled={busy || hardBlocked} onClick={onSave}>
          保存
        </Button>
      )}
      {onClear && (
        <Button size="small" disabled={busy} onClick={onClear}>
          清除
        </Button>
      )}
      <Button size="small" variant="outlined" disabled={busy || checkBlocked} onClick={onCheck}>
        检测
      </Button>
    </Stack>
  )
}

function ConfiguredRootField({
  label,
  value,
  valueError,
  onChange
}: Pick<
  RemoteRuntimeRootControlProps,
  'label' | 'value' | 'valueError' | 'onChange'
>): React.JSX.Element {
  return (
    <TextField
      size="small"
      fullWidth
      label={label}
      value={value}
      placeholder="~/.phi/runtime"
      onChange={(event) => onChange(event.target.value)}
      error={Boolean(valueError)}
      helperText={valueError ?? '绝对路径或以 ~/ 开头；留空时使用上一级设置。'}
      sx={{ '& input': { fontFamily: 'var(--font-mono)' } }}
    />
  )
}

export function RemoteRuntimeRootControl({
  label,
  value,
  effective,
  doctorState,
  doctorTargetKey,
  busy,
  onChange,
  onCheck,
  onConfirmWarnings,
  onSave,
  onClear,
  valueError
}: RemoteRuntimeRootControlProps): React.JSX.Element {
  const status = remoteRuntimeRootUiStatus(doctorState, doctorTargetKey)
  const hardBlocked = Boolean(valueError) || runtimeRootHasHardErrors(doctorState, doctorTargetKey)
  const needsConfirmation = runtimeRootNeedsWarningConfirmation(doctorState, doctorTargetKey)
  return (
    <Stack spacing={1}>
      <ConfiguredRootField
        label={label}
        value={value}
        valueError={valueError}
        onChange={onChange}
      />
      <Typography variant="caption" color="text.secondary">
        当前生效：{effective.configured}，来自 {SOURCE_LABELS[effective.source]}
      </Typography>
      <RuntimeRootActions
        busy={busy}
        hardBlocked={hardBlocked}
        checkBlocked={Boolean(valueError)}
        needsConfirmation={needsConfirmation}
        onCheck={onCheck}
        onSave={onSave}
        onClear={onClear}
      />
      {hardBlocked && status.phase === 'checked' && (
        <Alert severity="error">存在硬性错误，修正后才能保存。</Alert>
      )}
      <RemoteRuntimeRootResults
        status={status}
        onConfirmWarnings={needsConfirmation ? onConfirmWarnings : undefined}
      />
    </Stack>
  )
}
