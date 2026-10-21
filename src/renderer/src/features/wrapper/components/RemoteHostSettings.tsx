import { useUiLanguage } from '../../../lib/i18n'
import { remoteSetupCopy } from '../lib/remoteSetupCopy'
import { Box, Stack, Typography } from '@mui/material'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { OpenSshHost, RemoteHostProfile } from '../../../types'
import type { RemoteEnvironmentSettingInput } from '../../../../../shared/remoteEnvironmentTypes'
import { errorMessage } from '../../../../../shared/errorCodes'
import type {
  SshBootstrapFinalResult,
  SshBootstrapTarget
} from '../../../../../shared/sshBootstrapTypes'
import {
  createRemoteHostDoctorUiController,
  remoteHostDoctorTarget,
  type RemoteDoctorUiState
} from '../lib/remoteDoctorUi'
import type { SshHostAvailabilityStatus } from '../../../../../shared/sshHostAvailability'
import { sshHostAvailabilityFromDoctor } from '../lib/remoteDoctorUi'
import { remoteHostProbeTargets } from '../lib/remoteHostRows'
import { RemoteHostProfilesPanel, type RemoteHostDraft } from './RemoteHostProfilesPanel'
import { RemoteHostPasswordBootstrapDialog } from './RemoteHostPasswordBootstrapDialog'

const EMPTY_HOST_DRAFT: RemoteHostDraft = {
  id: '',
  label: '',
  hostAlias: '',
  hostname: '',
  user: '',
  port: '22',
  identityFile: '',
  source: 'ssh-config',
  authMode: 'passwordless'
}

/** SSH servers are global; project execution targets are chosen in the Wrapper flow. */
export function RemoteHostSettingsSection(): React.JSX.Element {
  useUiLanguage()
  const [hosts, setHosts] = useState<RemoteHostProfile[]>([])
  const [openSshHosts, setOpenSshHosts] = useState<OpenSshHost[]>([])
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string | null>(null)
  const [hostDraft, setHostDraft] = useState<RemoteHostDraft>(EMPTY_HOST_DRAFT)
  const [hostDialogOpen, setHostDialogOpen] = useState(false)
  const [hostBusy, setHostBusy] = useState(false)
  const [hostError, setHostError] = useState<string | null>(null)
  const [bootstrapTarget, setBootstrapTarget] = useState<SshBootstrapTarget | null>(null)
  const [bootstrapResult, setBootstrapResult] = useState<SshBootstrapFinalResult | null>(null)
  const [hostDoctorStates, setHostDoctorStates] = useState<Record<string, RemoteDoctorUiState>>({})
  const [savedAvailability, setSavedAvailability] = useState<
    Record<string, SshHostAvailabilityStatus>
  >({})
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
          const status = sshHostAvailabilityFromDoctor(state)
          if (!status) return
          setSavedAvailability((previous) => ({ ...previous, [hostId]: status }))
          void window.api
            .saveSshHostAvailability({
              hostId,
              status,
              checkedAt: new Date().toISOString()
            })
            .catch(() => undefined)
        }
      ),
    []
  )
  useEffect(() => (): void => doctorController.dispose(), [doctorController])

  const probeHosts = useCallback(
    (profiles: RemoteHostProfile[], discovered: OpenSshHost[]): void => {
      for (const target of remoteHostProbeTargets(profiles, discovered)) {
        void doctorController.check(target)
      }
    },
    [doctorController]
  )

  useEffect(() => {
    let cancelled = false
    void Promise.allSettled([
      window.api.listRemoteHosts(),
      window.api.listOpenSshHosts(),
      window.api.listSshHostAvailability()
    ])
      .then(([profiles, discovered, saved]) => {
        if (cancelled) return
        const nextHosts = profiles.status === 'fulfilled' ? profiles.value : []
        const nextDiscovered = discovered.status === 'fulfilled' ? discovered.value : []
        if (profiles.status === 'fulfilled') setHosts(nextHosts)
        if (discovered.status === 'fulfilled') setOpenSshHosts(nextDiscovered)
        if (saved.status === 'fulfilled') {
          setSavedAvailability(
            Object.fromEntries(saved.value.map((record) => [record.hostId, record.status]))
          )
        }
        const failure =
          profiles.status === 'rejected'
            ? profiles.reason
            : discovered.status === 'rejected'
              ? discovered.reason
              : null
        if (failure) setConfigError(errorMessage(failure))
        if (profiles.status === 'fulfilled' || discovered.status === 'fulfilled') {
          probeHosts(nextHosts, nextDiscovered)
        }
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false)
      })
    return (): void => {
      cancelled = true
    }
  }, [probeHosts])

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
      if (failure) setConfigError(errorMessage(failure))
      if (clearChecks) {
        doctorController.invalidate()
        setHostDoctorStates({})
      }
      probeHosts(
        profiles.status === 'fulfilled' ? profiles.value : hosts,
        discovered.status === 'fulfilled' ? discovered.value : openSshHosts
      )
    } finally {
      setConfigLoading(false)
    }
  }

  async function saveHost(): Promise<void> {
    setHostBusy(true)
    setHostError(null)
    try {
      const rawPort = hostDraft.port.trim()
      if (rawPort && !/^\d+$/.test(rawPort)) throw new Error(remoteSetupCopy.sshPortError)
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
      setHostError(errorMessage(error))
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
      setHostError(errorMessage(error))
    } finally {
      setHostBusy(false)
    }
  }

  async function saveEnvironment(
    host: RemoteHostProfile,
    input: RemoteEnvironmentSettingInput
  ): Promise<void> {
    setHostBusy(true)
    setHostError(null)
    try {
      const profile = await window.api.saveRemoteEnvironment(host.id, input)
      setHosts((previous) => [...previous.filter((item) => item.id !== profile.id), profile])
      doctorController.invalidate(host.id)
    } catch (error) {
      setHostError(errorMessage(error))
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
      source: host.source === 'ssh-config' ? 'ssh-config' : 'phi',
      authMode: 'existing-key'
    })
    setHostError(null)
    setHostDialogOpen(true)
  }

  function openPasswordBootstrap(): void {
    try {
      const rawPort = hostDraft.port.trim()
      if (rawPort && !/^\d+$/.test(rawPort)) throw new Error(remoteSetupCopy.sshPortError)
      const port = rawPort ? Number(rawPort) : 22
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(remoteSetupCopy.sshPortError)
      }
      const alias = hostDraft.hostAlias.trim()
      const hostname = hostDraft.hostname.trim()
      const user = hostDraft.user.trim()
      if (!alias || !hostname || !user) throw new Error(remoteSetupCopy.sshDetailsRequired)
      setHostError(null)
      setBootstrapResult(null)
      setBootstrapTarget({ alias, hostname, user, port })
      setHostDialogOpen(false)
    } catch (error) {
      setHostError(errorMessage(error))
    }
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">{remoteSetupCopy.remote}</Typography>
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
        savedAvailability={savedAvailability}
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
        onPasswordBootstrap={openPasswordBootstrap}
        onDelete={(id) => void removeHost(id)}
        onTest={(host) =>
          void doctorController.check(remoteHostDoctorTarget(host.id, host.hostAlias))
        }
        onEnvironmentSave={(host, input) => void saveEnvironment(host, input)}
      />
      {bootstrapTarget && (
        <RemoteHostPasswordBootstrapDialog
          open
          target={bootstrapTarget}
          client={window.api.sshBootstrap}
          onCompleted={(result) => {
            setBootstrapResult(result)
            if (result.configured) void reloadOpenSshHosts(false)
          }}
          onClose={() => {
            setBootstrapTarget(null)
            if (!bootstrapResult?.configured) setHostDialogOpen(true)
            else setHostDraft(EMPTY_HOST_DRAFT)
            setBootstrapResult(null)
          }}
        />
      )}
    </Stack>
  )
}

export default RemoteHostSettingsSection
