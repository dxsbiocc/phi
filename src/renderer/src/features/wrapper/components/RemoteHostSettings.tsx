import { Box, Stack, Typography } from '@mui/material'
import { useEffect, useMemo, useState } from 'react'

import type { OpenSshHost, RemoteHostProfile } from '../../../types'
import {
  createRemoteHostDoctorUiController,
  remoteHostDoctorTarget,
  type RemoteDoctorUiState
} from '../lib/remoteDoctorUi'
import { RemoteHostProfilesPanel, type RemoteHostDraft } from './RemoteHostProfilesPanel'

const EMPTY_HOST_DRAFT: RemoteHostDraft = {
  id: '',
  label: '',
  hostAlias: '',
  hostname: '',
  user: '',
  port: '',
  identityFile: '',
  source: 'ssh-config'
}

/** SSH servers are global; project execution targets are chosen in the Wrapper flow. */
export function RemoteHostSettingsSection(): React.JSX.Element {
  const [hosts, setHosts] = useState<RemoteHostProfile[]>([])
  const [openSshHosts, setOpenSshHosts] = useState<OpenSshHost[]>([])
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string | null>(null)
  const [hostDraft, setHostDraft] = useState<RemoteHostDraft>(EMPTY_HOST_DRAFT)
  const [hostDialogOpen, setHostDialogOpen] = useState(false)
  const [hostBusy, setHostBusy] = useState(false)
  const [hostError, setHostError] = useState<string | null>(null)
  const [hostDoctorStates, setHostDoctorStates] = useState<Record<string, RemoteDoctorUiState>>({})
  const doctorController = useMemo(
    () =>
      createRemoteHostDoctorUiController(
        (hostProfileId, remotePath, options) =>
          window.api.remoteDoctor(hostProfileId, remotePath, options),
        (hostId, state) => {
          setHostDoctorStates((previous) => {
            const next = { ...previous }
            if (state.phase === 'idle') delete next[hostId]
            else next[hostId] = state
            return next
          })
        }
      ),
    []
  )

  useEffect(() => (): void => doctorController.dispose(), [doctorController])

  useEffect(() => {
    let cancelled = false
    void Promise.allSettled([window.api.listRemoteHosts(), window.api.listOpenSshHosts()])
      .then(([profiles, discovered]) => {
        if (cancelled) return
        if (profiles.status === 'fulfilled') setHosts(profiles.value)
        if (discovered.status === 'fulfilled') setOpenSshHosts(discovered.value)
        const failure =
          profiles.status === 'rejected'
            ? profiles.reason
            : discovered.status === 'rejected'
              ? discovered.reason
              : null
        if (failure) setConfigError(failure instanceof Error ? failure.message : String(failure))
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false)
      })
    return (): void => {
      cancelled = true
    }
  }, [])

  async function reloadOpenSshHosts(clearChecks = true): Promise<void> {
    setConfigLoading(true)
    setConfigError(null)
    try {
      const [profiles, discovered] = await Promise.allSettled([
        window.api.listRemoteHosts(),
        window.api.listOpenSshHosts()
      ])
      if (profiles.status === 'fulfilled') setHosts(profiles.value)
      if (discovered.status === 'fulfilled') setOpenSshHosts(discovered.value)
      const failure =
        profiles.status === 'rejected'
          ? profiles.reason
          : discovered.status === 'rejected'
            ? discovered.reason
            : null
      if (failure) setConfigError(failure instanceof Error ? failure.message : String(failure))
      if (clearChecks) {
        doctorController.invalidate()
        setHostDoctorStates({})
      }
    } finally {
      setConfigLoading(false)
    }
  }

  async function saveHost(): Promise<void> {
    setHostBusy(true)
    setHostError(null)
    try {
      const rawPort = hostDraft.port.trim()
      if (rawPort && !/^\d+$/.test(rawPort)) throw new Error('SSH 端口必须为 1–65535 的整数')
      const connectionFields = {
        ...(hostDraft.user.trim() ? { user: hostDraft.user.trim() } : {}),
        ...(rawPort ? { port: Number(rawPort) } : {}),
        ...(hostDraft.identityFile.trim() ? { identityFile: hostDraft.identityFile.trim() } : {})
      }
      if (hostDraft.source === 'ssh-config') {
        await window.api.saveOpenSshHost({
          ...(hostDraft.id ? { originalAlias: hostDraft.hostAlias } : {}),
          alias: hostDraft.hostAlias,
          hostname: hostDraft.hostname,
          ...connectionFields
        })
        await reloadOpenSshHosts(false)
      } else {
        const profile = await window.api.saveRemoteHost({
          id: hostDraft.id,
          label: hostDraft.label,
          hostAlias: hostDraft.hostAlias,
          ...connectionFields
        })
        setHosts((previous) => [...previous.filter((item) => item.id !== profile.id), profile])
      }
      if (hostDraft.id) doctorController.invalidate(hostDraft.id)
      setHostDraft(EMPTY_HOST_DRAFT)
      setHostDialogOpen(false)
    } catch (error) {
      setHostError(error instanceof Error ? error.message : String(error))
    } finally {
      setHostBusy(false)
    }
  }

  async function removeHost(id: string): Promise<void> {
    setHostBusy(true)
    setHostError(null)
    try {
      await window.api.deleteRemoteHost(id)
      setHosts((previous) => previous.filter((item) => item.id !== id))
      doctorController.invalidate(id)
    } catch (error) {
      setHostError(error instanceof Error ? error.message : String(error))
    } finally {
      setHostBusy(false)
    }
  }

  function openEditHost(host: RemoteHostProfile): void {
    const configured = openSshHosts.find((item) => item.alias === host.hostAlias)
    setHostDraft({
      id: host.id,
      label: host.label,
      hostAlias: host.hostAlias,
      hostname: configured?.hostname ?? host.hostAlias,
      user: host.user ?? configured?.user ?? '',
      port: host.port === undefined ? String(configured?.port ?? '') : String(host.port),
      identityFile: host.identityFile ?? configured?.identityFiles[0] ?? '',
      source: host.source === 'ssh-config' ? 'ssh-config' : 'phi'
    })
    setHostError(null)
    setHostDialogOpen(true)
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">远程</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 760 }}>
          管理 SSH 服务器。新建远程项目时选择服务器和目录；本地项目需要远程计算时，可在 Wrapper
          中选择。
        </Typography>
      </Box>
      <RemoteHostProfilesPanel
        hosts={hosts}
        openSshHosts={openSshHosts}
        configLoading={configLoading}
        configError={configError}
        dialogOpen={hostDialogOpen}
        draft={hostDraft}
        busy={hostBusy}
        error={hostError}
        hostDoctorStates={hostDoctorStates}
        onDraftChange={setHostDraft}
        onOpenAdd={() => {
          setHostDraft(EMPTY_HOST_DRAFT)
          setHostError(null)
          setHostDialogOpen(true)
        }}
        onOpenEdit={openEditHost}
        onCloseDialog={() => {
          if (hostBusy) return
          setHostDialogOpen(false)
          setHostError(null)
        }}
        onReloadConfig={() => void reloadOpenSshHosts()}
        onSave={() => void saveHost()}
        onDelete={(id) => void removeHost(id)}
        onTest={(host) =>
          void doctorController.check(remoteHostDoctorTarget(host.id, host.hostAlias))
        }
      />
    </Stack>
  )
}

export default RemoteHostSettingsSection
