import { useUiLanguage } from '../../../lib/i18n'
import { localizeRemoteSetupMessage, remoteSetupCopy } from '../lib/remoteSetupCopy'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography
} from '@mui/material'

import type { RemoteDoctorReport } from '../../../../../shared/remoteDoctorTypes'
import type { ResolvedRemoteRuntimeRoot } from '../../../../../shared/remoteRuntimeRootTypes'
import { PhiIcons } from '../../../icons'
import type { ProjectRemoteConnection, RemoteHostProfile } from '../../../types'
import type { HpcDraft } from '../lib/remoteHpcDraft'
import type { RemoteDoctorUiState } from '../lib/remoteDoctorUi'
import { RemoteDependencyActions } from './RemoteDependencyActions'
import { RemoteDoctorPanel } from './RemoteDoctorPanel'
import { RemoteRuntimeRootControl } from './RemoteRuntimeRootControl'
import { WrapperHpcSettingsFields } from './WrapperHpcSettingsFields'

const ExpandIcon = PhiIcons.action.expand

export interface WrapperExecutionTargetDialogModel {
  open: boolean
  isRemoteProject: boolean
  remoteHostLabel: string
  boundHostAvailable: boolean
  connections: ProjectRemoteConnection[]
  connectionId: string
  hosts: RemoteHostProfile[]
  hostProfileId: string
  remoteRoot: string
  runtimeRootOverride: string
  runtimeRootEffective: ResolvedRemoteRuntimeRoot
  runtimeRootValueError: string | null
  runtimeRootHardBlocked: boolean
  hpc: HpcDraft
  localInputRoot: string
  remoteInputRoot: string
  loading: boolean
  saving: boolean
  installing: boolean
  checkingEnvironment: boolean
  environmentState: RemoteDoctorUiState
  environmentKey: string
  environmentReport: RemoteDoctorReport | null
  installStatus: { message: string; severity: 'success' | 'error' } | null
  error: string | null
}

export interface WrapperExecutionTargetDialogActions {
  chooseConnection: (id: string) => void
  setHostProfileId: (id: string) => void
  setRemoteRoot: (root: string) => void
  setRuntimeRootOverride: (root: string) => void
  setHpc: (draft: HpcDraft) => void
  setLocalInputRoot: (root: string) => void
  setRemoteInputRoot: (root: string) => void
  openRemoteSettings?: () => void
  close: () => void
  save: () => void
  checkEnvironment: () => void
  checkRuntimeRoot: () => void
  confirmRuntimeRootWarnings: () => void
  installNextflow: () => void
}

function SavedConnectionField({ model, actions }: DialogPartProps): React.JSX.Element | null {
  useUiLanguage()
  if (model.isRemoteProject || model.connections.length === 0) return null
  return (
    <TextField
      select
      size="small"
      fullWidth
      label={remoteSetupCopy.savedExecutionTargets}
      value={model.connectionId}
      onChange={(event) => actions.chooseConnection(event.target.value)}
    >
      <MenuItem value="">{remoteSetupCopy.newExecutionTarget}</MenuItem>
      {model.connections.map((connection) => (
        <MenuItem key={connection.id} value={connection.id}>
          {connection.label}
        </MenuItem>
      ))}
    </TextField>
  )
}

interface DialogPartProps {
  model: WrapperExecutionTargetDialogModel
  actions: WrapperExecutionTargetDialogActions
}

function RemoteHostField({ model, actions }: DialogPartProps): React.JSX.Element {
  useUiLanguage()
  if (model.isRemoteProject) {
    return (
      <TextField
        size="small"
        fullWidth
        label={remoteSetupCopy.sshServer}
        value={model.remoteHostLabel}
        slotProps={{ input: { readOnly: true } }}
        error={!model.loading && !model.boundHostAvailable}
        helperText={
          !model.loading && !model.boundHostAvailable ? remoteSetupCopy.boundServerUnavailable : ''
        }
      />
    )
  }
  return (
    <TextField
      select
      required
      size="small"
      fullWidth
      label={remoteSetupCopy.sshServer}
      value={model.hostProfileId}
      disabled={model.loading}
      onChange={(event) => actions.setHostProfileId(event.target.value)}
      helperText={
        model.hosts.length === 0 && !model.loading
          ? remoteSetupCopy.addServerInSettings
          : remoteSetupCopy.openSshConfigurationHelp
      }
    >
      <MenuItem value="">{remoteSetupCopy.selectServer}</MenuItem>
      {model.hosts.map((host) => (
        <MenuItem key={host.id} value={host.id}>
          {host.label} · {host.hostAlias}
        </MenuItem>
      ))}
    </TextField>
  )
}

function RemoteRootField({ model, actions }: DialogPartProps): React.JSX.Element {
  useUiLanguage()
  return (
    <TextField
      required
      size="small"
      fullWidth
      label={remoteSetupCopy.serverWorkingDirectory}
      value={model.remoteRoot}
      onChange={
        model.isRemoteProject ? undefined : (event) => actions.setRemoteRoot(event.target.value)
      }
      placeholder="/data/lab/project"
      helperText={
        model.isRemoteProject
          ? remoteSetupCopy.boundDirectoryHelp
          : remoteSetupCopy.wrapperOutputDirectoryHelp
      }
      slotProps={model.isRemoteProject ? { input: { readOnly: true } } : undefined}
      sx={{ '& input': { fontFamily: 'var(--font-mono)' } }}
    />
  )
}

function RuntimeRootField({ model, actions }: DialogPartProps): React.JSX.Element {
  useUiLanguage()
  return (
    <RemoteRuntimeRootControl
      label={remoteSetupCopy.projectOverride}
      value={model.runtimeRootOverride}
      effective={model.runtimeRootEffective}
      doctorState={model.environmentState}
      doctorTargetKey={model.environmentKey}
      busy={model.loading || model.saving || model.checkingEnvironment}
      valueError={model.runtimeRootValueError}
      onChange={actions.setRuntimeRootOverride}
      onCheck={actions.checkRuntimeRoot}
      onConfirmWarnings={actions.confirmRuntimeRootWarnings}
    />
  )
}

function RuntimeFields({ model, actions }: DialogPartProps): React.JSX.Element {
  useUiLanguage()
  return (
    <>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <TextField
          select
          size="small"
          fullWidth
          label={remoteSetupCopy.scheduler}
          value={model.hpc.scheduler}
          onChange={(event) =>
            actions.setHpc({
              ...model.hpc,
              scheduler: event.target.value as HpcDraft['scheduler'],
              ...(event.target.value === 'local' ? { controller: 'login' as const } : {})
            })
          }
        >
          <MenuItem value="slurm">{remoteSetupCopy.slurmCluster}</MenuItem>
          <MenuItem value="local">{remoteSetupCopy.runDirectlyOnServer}</MenuItem>
        </TextField>
        <TextField
          select
          size="small"
          fullWidth
          label={remoteSetupCopy.softwareEnvironment}
          value={model.hpc.runtime}
          onChange={(event) =>
            actions.setHpc({ ...model.hpc, runtime: event.target.value as HpcDraft['runtime'] })
          }
        >
          <MenuItem value="singularity">Singularity / Apptainer</MenuItem>
          <MenuItem value="conda">Conda</MenuItem>
          <MenuItem value="docker">Docker</MenuItem>
        </TextField>
      </Stack>
      <Accordion variant="outlined" disableGutters>
        <AccordionSummary expandIcon={<ExpandIcon fontSize="small" />}>
          <Typography variant="body2">{remoteSetupCopy.moreRunSettings}</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <WrapperHpcSettingsFields value={model.hpc} onChange={actions.setHpc} advancedOnly />
        </AccordionDetails>
      </Accordion>
    </>
  )
}

function InputPathMapping({ model, actions }: DialogPartProps): React.JSX.Element | null {
  useUiLanguage()
  if (model.isRemoteProject) return null
  return (
    <Accordion variant="outlined" disableGutters>
      <AccordionSummary expandIcon={<ExpandIcon fontSize="small" />}>
        <Typography variant="body2">{remoteSetupCopy.dataPathMapping}</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.5}>
          <Typography variant="caption" color="text.secondary">
            {remoteSetupCopy.pathMappingHelp}
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              size="small"
              fullWidth
              label={remoteSetupCopy.localInputRoot}
              value={model.localInputRoot}
              onChange={(event) => actions.setLocalInputRoot(event.target.value)}
            />
            <TextField
              size="small"
              fullWidth
              label={remoteSetupCopy.serverInputRoot}
              value={model.remoteInputRoot}
              onChange={(event) => actions.setRemoteInputRoot(event.target.value)}
            />
          </Stack>
        </Stack>
      </AccordionDetails>
    </Accordion>
  )
}

function EnvironmentSection({ model, actions }: DialogPartProps): React.JSX.Element {
  useUiLanguage()
  return (
    <>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          size="small"
          variant="outlined"
          disabled={model.loading || model.saving || model.checkingEnvironment}
          onClick={actions.checkEnvironment}
        >
          {model.checkingEnvironment
            ? remoteSetupCopy.checking
            : remoteSetupCopy.checkRuntimeEnvironment}
        </Button>
        <Typography variant="caption" color="text.secondary">
          {remoteSetupCopy.checkOnlyHelp}
        </Typography>
      </Stack>
      <RemoteDoctorPanel
        state={model.environmentState}
        targetKey={model.environmentKey}
        onOpenRemoteSettings={actions.openRemoteSettings}
      />
      {model.environmentReport && (
        <RemoteDependencyActions
          report={model.environmentReport}
          installing={model.installing}
          onInstallNextflow={actions.installNextflow}
        />
      )}
      {model.installStatus && (
        <Alert severity={model.installStatus.severity}>{model.installStatus.message}</Alert>
      )}
      {model.error && <Alert severity="error">{localizeRemoteSetupMessage(model.error)}</Alert>}
    </>
  )
}

function DialogBody(props: DialogPartProps): React.JSX.Element {
  useUiLanguage()
  const { model, actions } = props
  const missingHost = model.isRemoteProject ? !model.boundHostAvailable : model.hosts.length === 0
  return (
    <Stack spacing={2} sx={{ pt: 0.5 }}>
      <Typography variant="body2" color="text.secondary">
        {model.isRemoteProject
          ? remoteSetupCopy.remoteWrapperBindingHelp
          : remoteSetupCopy.localRemoteWrapperHelp}
      </Typography>
      <SavedConnectionField {...props} />
      <RemoteHostField {...props} />
      {!model.loading && missingHost && actions.openRemoteSettings && (
        <Button size="small" onClick={actions.openRemoteSettings} sx={{ alignSelf: 'flex-start' }}>
          {remoteSetupCopy.addSshServer}
        </Button>
      )}
      <RemoteRootField {...props} />
      <RuntimeRootField {...props} />
      <RuntimeFields {...props} />
      <InputPathMapping {...props} />
      <EnvironmentSection {...props} />
    </Stack>
  )
}

export function WrapperExecutionTargetDialog({
  model,
  actions
}: DialogPartProps): React.JSX.Element {
  useUiLanguage()
  return (
    <Dialog open={model.open} onClose={actions.close} maxWidth="sm" fullWidth>
      <DialogTitle>
        {model.isRemoteProject
          ? remoteSetupCopy.remoteWrapperExecutionTitle
          : remoteSetupCopy.localRemoteTargetTitle}
      </DialogTitle>
      <DialogContent dividers>
        <Box
          component="fieldset"
          disabled={model.installing}
          sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}
        >
          <DialogBody model={model} actions={actions} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={actions.close} disabled={model.saving || model.installing}>
          {remoteSetupCopy.cancel}
        </Button>
        <Button
          variant="contained"
          onClick={actions.save}
          disabled={
            model.saving || model.loading || model.installing || model.runtimeRootHardBlocked
          }
        >
          {model.saving
            ? remoteSetupCopy.saving
            : model.isRemoteProject
              ? remoteSetupCopy.saveExecutionMode
              : remoteSetupCopy.saveExecutionTarget}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
