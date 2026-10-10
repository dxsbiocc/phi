import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import type { RemoteHostProfile } from '../../../types'
import type { RemoteRuntimeRootWarningCode } from '../../../../../shared/remoteRuntimeRootTypes'
import type { RemoteMicromambaUiState } from '../components/RemoteMicromambaControl'
import { createRemoteHostDoctorUiController, remoteHostDoctorTarget } from '../lib/remoteDoctorUi'

type DoctorController = Pick<ReturnType<typeof createRemoteHostDoctorUiController>, 'check'>
type StateMap = Record<string, RemoteMicromambaUiState>

function failedState(): RemoteMicromambaUiState {
  return {
    phase: 'done',
    result: {
      status: 'failed',
      version: '2.9.0-0',
      platform: 'linux-x64',
      durationMs: 0,
      warningCodes: [],
      errorCode: 'status-check-failed',
      message: 'micromamba 安装未完成，请检查 SSH 连接后重试。'
    }
  }
}

async function runInstall(
  doctorController: DoctorController,
  requests: Map<string, string>,
  setStates: Dispatch<SetStateAction<StateMap>>,
  host: RemoteHostProfile,
  runtimeRoot: string,
  confirmedWarnings?: readonly RemoteRuntimeRootWarningCode[],
  downloadMirrorPrefix?: string
): Promise<void> {
  const requestId = crypto.randomUUID()
  requests.set(requestId, host.id)
  setStates((previous) => ({
    ...previous,
    [host.id]: {
      phase: 'running',
      progress: { requestId, stage: 'probe', message: '正在检测服务器平台…' }
    }
  }))
  try {
    const result = await window.api.remoteMicromamba({
      requestId,
      hostProfileId: host.id,
      runtimeRoot,
      downloadMirrorPrefix,
      confirmedWarnings
    })
    setStates((previous) => ({ ...previous, [host.id]: { phase: 'done', result } }))
    if (result.status === 'installed' || result.status === 'already-installed') {
      void doctorController.check(remoteHostDoctorTarget(host.id, host.hostAlias, runtimeRoot))
    }
  } catch {
    setStates((previous) => ({ ...previous, [host.id]: failedState() }))
  } finally {
    requests.delete(requestId)
  }
}

export function useRemoteMicromambaSettings(doctorController: DoctorController): {
  micromambaStates: StateMap
  installMicromamba: (
    host: RemoteHostProfile,
    runtimeRoot: string,
    confirmedWarnings?: readonly RemoteRuntimeRootWarningCode[],
    downloadMirrorPrefix?: string
  ) => Promise<void>
} {
  const [micromambaStates, setMicromambaStates] = useState<StateMap>({})
  const requests = useRef(new Map<string, string>())
  useEffect(
    () =>
      window.api.onRemoteMicromambaProgress((progress) => {
        const hostId = requests.current.get(progress.requestId)
        if (!hostId) return
        setMicromambaStates((previous) => ({
          ...previous,
          [hostId]: { phase: 'running', progress }
        }))
      }),
    []
  )

  return {
    micromambaStates,
    installMicromamba: (host, root, warnings, mirror) =>
      runInstall(
        doctorController,
        requests.current,
        setMicromambaStates,
        host,
        root,
        warnings,
        mirror
      )
  }
}
