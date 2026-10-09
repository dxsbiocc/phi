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
import { PhiIcons } from '../../../icons'
import type { ProjectRemoteConnection, RemoteHostProfile } from '../../../types'
import type { HpcDraft } from '../lib/remoteHpcDraft'
import type { RemoteDoctorUiState } from '../lib/remoteDoctorUi'
import { RemoteDependencyActions } from './RemoteDependencyActions'
import { RemoteDoctorPanel } from './RemoteDoctorPanel'
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
  setHpc: (draft: HpcDraft) => void
  setLocalInputRoot: (root: string) => void
  setRemoteInputRoot: (root: string) => void
  openRemoteSettings?: () => void
  close: () => void
  save: () => void
  checkEnvironment: () => void
  installNextflow: () => void
}

function SavedConnectionField({ model, actions }: DialogPartProps): React.JSX.Element | null {
  if (model.isRemoteProject || model.connections.length === 0) return null
  return (
    <TextField
      select
      size="small"
      fullWidth
      label="已保存的计算目标"
      value={model.connectionId}
      onChange={(event) => actions.chooseConnection(event.target.value)}
    >
      <MenuItem value="">新建计算目标</MenuItem>
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
  if (model.isRemoteProject) {
    return (
      <TextField
        size="small"
        fullWidth
        label="SSH 服务器"
        value={model.remoteHostLabel}
        slotProps={{ input: { readOnly: true } }}
        error={!model.loading && !model.boundHostAvailable}
        helperText={
          !model.loading && !model.boundHostAvailable
            ? '绑定的服务器已不可用，请在远程设置中恢复'
            : ''
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
      label="SSH 服务器"
      value={model.hostProfileId}
      disabled={model.loading}
      onChange={(event) => actions.setHostProfileId(event.target.value)}
      helperText={
        model.hosts.length === 0 && !model.loading
          ? '先在“设置 → 远程”添加服务器'
          : '使用系统 OpenSSH 配置中的主机和认证方式'
      }
    >
      <MenuItem value="">选择服务器</MenuItem>
      {model.hosts.map((host) => (
        <MenuItem key={host.id} value={host.id}>
          {host.label} · {host.hostAlias}
        </MenuItem>
      ))}
    </TextField>
  )
}

function RemoteRootField({ model, actions }: DialogPartProps): React.JSX.Element {
  return (
    <TextField
      required
      size="small"
      fullWidth
      label="服务器工作目录"
      value={model.remoteRoot}
      onChange={
        model.isRemoteProject ? undefined : (event) => actions.setRemoteRoot(event.target.value)
      }
      placeholder="/data/lab/project"
      helperText={
        model.isRemoteProject
          ? '与远程项目绑定的目录一致'
          : 'Wrapper 的任务记录和输出保存在该目录下'
      }
      slotProps={model.isRemoteProject ? { input: { readOnly: true } } : undefined}
      sx={{ '& input': { fontFamily: 'var(--font-mono)' } }}
    />
  )
}

function RuntimeFields({ model, actions }: DialogPartProps): React.JSX.Element {
  return (
    <>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <TextField
          select
          size="small"
          fullWidth
          label="任务调度"
          value={model.hpc.scheduler}
          onChange={(event) =>
            actions.setHpc({
              ...model.hpc,
              scheduler: event.target.value as HpcDraft['scheduler'],
              ...(event.target.value === 'local' ? { controller: 'login' as const } : {})
            })
          }
        >
          <MenuItem value="slurm">Slurm 集群</MenuItem>
          <MenuItem value="local">直接在服务器运行</MenuItem>
        </TextField>
        <TextField
          select
          size="small"
          fullWidth
          label="软件环境"
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
          <Typography variant="body2">更多运行参数</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <WrapperHpcSettingsFields value={model.hpc} onChange={actions.setHpc} advancedOnly />
        </AccordionDetails>
      </Accordion>
    </>
  )
}

function InputPathMapping({ model, actions }: DialogPartProps): React.JSX.Element | null {
  if (model.isRemoteProject) return null
  return (
    <Accordion variant="outlined" disableGutters>
      <AccordionSummary expandIcon={<ExpandIcon fontSize="small" />}>
        <Typography variant="body2">已有数据的路径映射（可选）</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.5}>
          <Typography variant="caption" color="text.secondary">
            仅当同一份数据已在服务器上时填写。Phi 不会上传本地文件。
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              size="small"
              fullWidth
              label="本机输入根目录"
              value={model.localInputRoot}
              onChange={(event) => actions.setLocalInputRoot(event.target.value)}
            />
            <TextField
              size="small"
              fullWidth
              label="服务器对应根目录"
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
  return (
    <>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          size="small"
          variant="outlined"
          disabled={model.loading || model.saving || model.checkingEnvironment}
          onClick={actions.checkEnvironment}
        >
          {model.checkingEnvironment ? '检查中…' : '检查运行环境'}
        </Button>
        <Typography variant="caption" color="text.secondary">
          只检查目录和命令；不会安装或修改服务器。
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
      {model.error && <Alert severity="error">{model.error}</Alert>}
    </>
  )
}

function DialogBody(props: DialogPartProps): React.JSX.Element {
  const { model, actions } = props
  const missingHost = model.isRemoteProject ? !model.boundHostAvailable : model.hosts.length === 0
  return (
    <Stack spacing={2} sx={{ pt: 0.5 }}>
      <Typography variant="body2" color="text.secondary">
        {model.isRemoteProject
          ? '该项目的 Wrapper 固定在绑定的服务器和项目目录运行。'
          : '服务器执行只影响明确指定为远程的 Wrapper。项目文件仍在本机，Phi 不会自动上传数据。'}
      </Typography>
      <SavedConnectionField {...props} />
      <RemoteHostField {...props} />
      {!model.loading && missingHost && actions.openRemoteSettings && (
        <Button size="small" onClick={actions.openRemoteSettings} sx={{ alignSelf: 'flex-start' }}>
          添加 SSH 服务器
        </Button>
      )}
      <RemoteRootField {...props} />
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
  return (
    <Dialog open={model.open} onClose={actions.close} maxWidth="sm" fullWidth>
      <DialogTitle>
        {model.isRemoteProject ? '远程项目的 Wrapper 运行方式' : '本地项目的远程计算目标'}
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
          取消
        </Button>
        <Button
          variant="contained"
          onClick={actions.save}
          disabled={model.saving || model.loading || model.installing}
        >
          {model.saving ? '保存中…' : model.isRemoteProject ? '保存运行方式' : '保存计算目标'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
