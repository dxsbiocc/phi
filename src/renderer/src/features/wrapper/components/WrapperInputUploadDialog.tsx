import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Typography
} from '@mui/material'
import { useEffect, useMemo, useState } from 'react'

import type { RemoteProjectUploadJob } from '../../../../../shared/remoteProjectUploadTypes'
import type { WrapperRunPlan } from '../../../../../shared/wrapperTypes'
import {
  remoteUploadDestinationDirectory,
  selectedRemoteUploadDestination
} from '../../../lib/remoteUploadDestination'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function WrapperInputUploadDialog({
  plan,
  inputId,
  open,
  onClose,
  onUploaded
}: {
  plan: WrapperRunPlan
  inputId: string
  open: boolean
  onClose: () => void
  onUploaded: (plan: WrapperRunPlan) => void
}): React.JSX.Element {
  const [sourcePaths, setSourcePaths] = useState<string[]>([])
  const [job, setJob] = useState<RemoteProjectUploadJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const target = plan.targetSelection
  const projectLocation = target?.projectLocation
  const destinationDirectory = useMemo(() => {
    if (!target || projectLocation?.kind !== 'ssh' || !target.hostAlias) return null
    const selected = selectedRemoteUploadDestination(target.projectId)
    if (!selected) return ''
    return remoteUploadDestinationDirectory(
      selected,
      target.hostAlias,
      projectLocation.canonicalRoot
    )
  }, [projectLocation, target])

  useEffect(() => {
    if (!open || typeof window.api.onInputFilesDropped !== 'function') return undefined
    return window.api.onInputFilesDropped((paths, dropTarget) => {
      if (dropTarget.kind !== 'wrapper-input') return
      if (paths.length !== 1) {
        setError('每个 Wrapper 输入一次请选择或拖入一个文件或目录。')
        return
      }
      setError('')
      setSourcePaths(paths)
    })
  }, [open])

  useEffect(() => {
    if (!open || typeof window.api.onRemoteProjectUploadsChanged !== 'function') return undefined
    return window.api.onRemoteProjectUploadsChanged((next) => {
      if (next.id === job?.id) setJob(next)
    })
  }, [job?.id, open])

  const choose = async (): Promise<void> => {
    setError('')
    try {
      const paths = await window.api.pickLocalUploadFiles()
      if (paths.length === 0) return
      if (paths.length !== 1) {
        setError('每个 Wrapper 输入一次请选择一个文件或目录。')
        return
      }
      setSourcePaths(paths)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const upload = async (): Promise<void> => {
    if (!target || projectLocation?.kind !== 'ssh' || destinationDirectory === null) {
      setError('Wrapper 计划没有可用的 SSH 项目上传落点。')
      return
    }
    if (sourcePaths.length !== 1) {
      setError('请先选择一个本机文件或目录。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const prepared = await window.api.prepareRemoteProjectUpload(target.projectId, {
        sourcePaths,
        destinationDirectory
      })
      setJob(prepared)
      let confirmed = !prepared.requiresConfirmation
      if (prepared.requiresConfirmation) {
        confirmed = window.confirm(
          `将上传 ${prepared.totalFiles} 个文件（${(prepared.totalBytes / 1024 ** 3).toFixed(2)} GiB），是否继续？`
        )
      }
      if (!confirmed) {
        await window.api.cancelRemoteProjectUpload(prepared.id)
        return
      }
      const started = await window.api.startRemoteProjectUpload(target.projectId, prepared.id, {
        confirmed
      })
      setJob(started)
      const revised = await window.api.completeWrapperInputUpload(
        prepared.id,
        plan.planId,
        inputId,
        plan.revision
      )
      onUploaded(revised)
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    if (!job || !['queued', 'uploading', 'verifying'].includes(job.status)) return
    await window.api.cancelRemoteProjectUpload(job.id)
  }

  const percent = job && job.totalBytes > 0 ? (job.bytesTransferred / job.totalBytes) * 100 : 0
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>为 {inputId} 选择本机输入</DialogTitle>
      <DialogContent data-phi-file-drop-target="wrapper-input" sx={{ pt: 1, minHeight: 180 }}>
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">
            选择文件或目录，或拖到此对话框。SSH 项目会先上传并校验，再允许提交 Wrapper。
          </Typography>
          <Button variant="outlined" onClick={() => void choose()} disabled={busy}>
            选择本机文件或目录
          </Button>
          <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
            {sourcePaths[0] ?? '尚未选择'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            落点：{destinationDirectory ? `项目/${destinationDirectory}` : '远程项目根目录'}
          </Typography>
          {job && ['queued', 'uploading', 'verifying'].includes(job.status) && (
            <LinearProgress variant="determinate" value={Math.min(100, percent)} />
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {job && ['queued', 'uploading', 'verifying'].includes(job.status) && (
          <Button color="error" onClick={() => void cancel()}>
            取消上传
          </Button>
        )}
        <Button onClick={onClose} disabled={busy}>
          关闭
        </Button>
        <Button
          variant="contained"
          onClick={() => void upload()}
          disabled={busy || sourcePaths.length !== 1}
        >
          {busy ? '上传中…' : '上传并绑定输入'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
