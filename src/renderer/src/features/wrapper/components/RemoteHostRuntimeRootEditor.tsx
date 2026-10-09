import { useMemo, useState } from 'react'

import type { RemoteHostProfile } from '../../../types'
import {
  remoteDoctorTargetKey,
  remoteHostDoctorTarget,
  type RemoteDoctorUiState
} from '../lib/remoteDoctorUi'
import {
  normalizeRemoteRuntimeRootValue,
  remoteRuntimeRootValueError
} from '../lib/remoteRuntimeRootUi'
import { RemoteRuntimeRootControl } from './RemoteRuntimeRootControl'

export function RemoteHostRuntimeRootEditor({
  host,
  doctorState,
  busy,
  onSave,
  onCheck
}: {
  host: RemoteHostProfile
  doctorState: RemoteDoctorUiState
  busy: boolean
  onSave: (host: RemoteHostProfile, runtimeRoot?: string) => void
  onCheck: (host: RemoteHostProfile, runtimeRoot?: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState(host.runtimeRoot ?? '')
  const normalized = normalizeRemoteRuntimeRootValue(value)
  const valueError = remoteRuntimeRootValueError(value)
  const target = useMemo(
    () => remoteHostDoctorTarget(host.id, host.hostAlias, normalized ?? ''),
    [host.hostAlias, host.id, normalized]
  )
  const save = (): void => onSave(host, normalized)
  return (
    <RemoteRuntimeRootControl
      label="运行时根目录"
      value={value}
      effective={
        host.runtimeRoot
          ? { source: 'host', configured: host.runtimeRoot }
          : { source: 'default', configured: '~/.phi/runtime' }
      }
      doctorState={doctorState}
      doctorTargetKey={remoteDoctorTargetKey(target)}
      busy={busy}
      valueError={valueError}
      onChange={setValue}
      onCheck={() => onCheck(host, normalized)}
      onSave={save}
      onClear={() => {
        setValue('')
        onSave(host, undefined)
      }}
      onConfirmWarnings={save}
    />
  )
}
