import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import type { RemoteRuntimeRootWarningCode } from '../../../../../shared/remoteRuntimeRootTypes'
import type { RemoteHostProfile } from '../../../types'
import type { RemoteRipgrepUiState } from '../components/RemoteRipgrepControl'
import { createRemoteHostDoctorUiController, remoteHostDoctorTarget } from '../lib/remoteDoctorUi'

type DoctorController = Pick<ReturnType<typeof createRemoteHostDoctorUiController>, 'check'>
type StateMap = Record<string, RemoteRipgrepUiState>

function failedState(): RemoteRipgrepUiState {
  return {
    phase: 'done',
    result: {
      status: 'failed',
      durationMs: 0,
      errorCode: 'status-check-failed',
      message: 'ripgrep 操作未完成，请检查 SSH 连接后重试。'
    }
  }
}

async function runOperation(
  doctor: DoctorController,
  requests: Map<string, string>,
  setStates: Dispatch<SetStateAction<StateMap>>,
  host: RemoteHostProfile,
  runtimeRoot: string,
  action: 'status' | 'install',
  warnings?: readonly RemoteRuntimeRootWarningCode[],
  forceManaged?: boolean
): Promise<void> {
  const requestId = crypto.randomUUID()
  requests.set(requestId, host.id)
  setStates((previous) => ({ ...previous, [host.id]: { phase: 'running' } }))
  try {
    const result = await window.api.remoteRipgrep({
      action,
      requestId,
      hostProfileId: host.id,
      runtimeRoot,
      confirmedWarnings: warnings,
      forceManaged
    })
    setStates((previous) => ({ ...previous, [host.id]: { phase: 'done', result } }))
    if (action === 'install' && ['installed', 'already-installed'].includes(result.status)) {
      void doctor.check(remoteHostDoctorTarget(host.id, host.hostAlias, runtimeRoot))
    }
  } catch {
    setStates((previous) => ({ ...previous, [host.id]: failedState() }))
  } finally {
    requests.delete(requestId)
  }
}

export function useRemoteRipgrepSettings(doctor: DoctorController): {
  ripgrepStates: StateMap
  checkRipgrep: (host: RemoteHostProfile, runtimeRoot: string) => Promise<void>
  installRipgrep: (
    host: RemoteHostProfile,
    runtimeRoot: string,
    warnings?: readonly RemoteRuntimeRootWarningCode[],
    forceManaged?: boolean
  ) => Promise<void>
} {
  const [ripgrepStates, setRipgrepStates] = useState<StateMap>({})
  const requests = useRef(new Map<string, string>())
  const checkRipgrep = useCallback(
    (host: RemoteHostProfile, root: string) =>
      runOperation(doctor, requests.current, setRipgrepStates, host, root, 'status'),
    [doctor]
  )
  const installRipgrep = useCallback(
    (
      host: RemoteHostProfile,
      root: string,
      warnings?: readonly RemoteRuntimeRootWarningCode[],
      force?: boolean
    ) =>
      runOperation(
        doctor,
        requests.current,
        setRipgrepStates,
        host,
        root,
        'install',
        warnings,
        force
      ),
    [doctor]
  )
  useEffect(
    () =>
      window.api.onRemoteRipgrepProgress((progress) => {
        const hostId = requests.current.get(progress.requestId)
        if (!hostId) return
        setRipgrepStates((previous) => ({
          ...previous,
          [hostId]: { phase: 'running', progress }
        }))
      }),
    []
  )
  return {
    ripgrepStates,
    checkRipgrep,
    installRipgrep
  }
}
