import { useMemo, useState } from 'react'
import { Divider, Stack, Typography } from '@mui/material'

import type { RemoteHostProfile } from '../../../types'
import type { RemoteRuntimeRootWarningCode } from '../../../../../shared/remoteRuntimeRootTypes'
import {
  remoteDoctorTargetKey,
  remoteHostDoctorTarget,
  type RemoteDoctorUiState
} from '../lib/remoteDoctorUi'
import {
  normalizeRemoteRuntimeRootValue,
  remoteRuntimeRootValueError
} from '../lib/remoteRuntimeRootUi'
import { RemoteMicromambaControl, type RemoteMicromambaUiState } from './RemoteMicromambaControl'
import { RemoteRuntimeRootControl } from './RemoteRuntimeRootControl'

interface RemoteHostRuntimeRootEditorProps {
  host: RemoteHostProfile
  doctorState: RemoteDoctorUiState
  busy: boolean
  onSave: (host: RemoteHostProfile, runtimeRoot?: string) => void
  onCheck: (host: RemoteHostProfile, runtimeRoot?: string) => void
  micromambaState?: RemoteMicromambaUiState
  onMicromambaInstall?: (
    host: RemoteHostProfile,
    runtimeRoot: string,
    confirmedWarnings?: readonly RemoteRuntimeRootWarningCode[],
    downloadMirrorPrefix?: string
  ) => void
  onMicromambaMirrorSave?: (host: RemoteHostProfile, downloadMirrorPrefix?: string) => void
}

function RuntimeRootEditorControl(props: {
  host: RemoteHostProfile
  doctorState: RemoteDoctorUiState
  targetKey: string
  value: string
  valueError: string | null
  busy: boolean
  onValue: (value: string) => void
  onSave: () => void
  onCheck: () => void
  onClear: () => void
}): React.JSX.Element {
  return (
    <RemoteRuntimeRootControl
      label="运行时根目录"
      value={props.value}
      effective={
        props.host.runtimeRoot
          ? { source: 'host', configured: props.host.runtimeRoot }
          : { source: 'default', configured: '~/.phi/runtime' }
      }
      doctorState={props.doctorState}
      doctorTargetKey={props.targetKey}
      busy={props.busy}
      valueError={props.valueError}
      onChange={props.onValue}
      onCheck={props.onCheck}
      onSave={props.onSave}
      onClear={props.onClear}
      onConfirmWarnings={props.onSave}
    />
  )
}

function MicromambaEditor(props: {
  host: RemoteHostProfile
  doctorState: RemoteDoctorUiState
  targetKey: string
  runtimeRoot: string
  downloadMirrorPrefix: string
  state?: RemoteMicromambaUiState
  disabled: boolean
  onMirrorChange: (value: string) => void
  onInstall?: RemoteHostRuntimeRootEditorProps['onMicromambaInstall']
  onMirrorSave?: RemoteHostRuntimeRootEditorProps['onMicromambaMirrorSave']
}): React.JSX.Element | null {
  if (!props.onInstall) return null
  const capabilityProfile =
    props.doctorState.phase === 'done' && props.doctorState.key === props.targetKey
      ? props.doctorState.report.capabilityProfile
      : undefined
  return (
    <RemoteMicromambaControl
      capabilityProfile={capabilityProfile}
      runtimeRoot={props.runtimeRoot}
      downloadMirrorPrefix={props.downloadMirrorPrefix}
      state={props.state ?? { phase: 'idle' }}
      disabled={props.disabled}
      onDownloadMirrorPrefixChange={props.onMirrorChange}
      onDownloadMirrorPrefixSave={(prefix) => props.onMirrorSave?.(props.host, prefix)}
      onInstall={(warnings, prefix) =>
        props.onInstall?.(props.host, props.runtimeRoot, warnings, prefix)
      }
    />
  )
}

export function RemoteHostRuntimeRootEditor(
  props: RemoteHostRuntimeRootEditorProps
): React.JSX.Element {
  const [value, setValue] = useState(props.host.runtimeRoot ?? '')
  const [downloadMirrorPrefix, setDownloadMirrorPrefix] = useState(
    props.host.downloadMirrorPrefix ?? ''
  )
  const normalized = normalizeRemoteRuntimeRootValue(value)
  const valueError = remoteRuntimeRootValueError(value)
  const targetKey = useMemo(
    () =>
      remoteDoctorTargetKey(
        remoteHostDoctorTarget(props.host.id, props.host.hostAlias, normalized ?? '')
      ),
    [props.host.hostAlias, props.host.id, normalized]
  )
  const save = (): void => props.onSave(props.host, normalized)
  return (
    <Stack spacing={2.25} sx={{ py: 1 }}>
      <Stack spacing={1}>
        <Typography variant="subtitle2" sx={{ fontWeight: 750 }}>
          运行目录
        </Typography>
        <RuntimeRootEditorControl
          {...props}
          targetKey={targetKey}
          value={value}
          valueError={valueError}
          onValue={setValue}
          onSave={save}
          onCheck={() => props.onCheck(props.host, normalized)}
          onClear={() => {
            setValue('')
            props.onSave(props.host, undefined)
          }}
        />
      </Stack>
      {props.onMicromambaInstall && <Divider />}
      <MicromambaEditor
        host={props.host}
        doctorState={props.doctorState}
        targetKey={targetKey}
        runtimeRoot={normalized ?? props.host.runtimeRoot ?? '~/.phi/runtime'}
        downloadMirrorPrefix={downloadMirrorPrefix}
        state={props.micromambaState}
        disabled={props.busy || Boolean(valueError)}
        onMirrorChange={setDownloadMirrorPrefix}
        onInstall={props.onMicromambaInstall}
        onMirrorSave={props.onMicromambaMirrorSave}
      />
    </Stack>
  )
}
