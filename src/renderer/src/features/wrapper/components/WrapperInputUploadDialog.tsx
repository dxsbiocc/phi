import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { localizeWrapperMessage, wrapperCopy } from '../lib/wrapperCopy'
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
  useUiLanguage()
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
        setError(wrapperCopy.chooseOneInput)
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
        setError(wrapperCopy.chooseOneInput)
        return
      }
      setSourcePaths(paths)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const upload = async (): Promise<void> => {
    if (!target || projectLocation?.kind !== 'ssh' || destinationDirectory === null) {
      setError(wrapperCopy.missingUploadTarget)
      return
    }
    if (sourcePaths.length !== 1) {
      setError(wrapperCopy.chooseInputFirst)
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
          wrapperCopy.confirmUpload(
            prepared.totalFiles,
            (prepared.totalBytes / 1024 ** 3).toFixed(2)
          )
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
      <DialogTitle>{wrapperCopy.inputTitle(inputId)}</DialogTitle>
      <DialogContent data-phi-file-drop-target="wrapper-input" sx={{ pt: 1, minHeight: 180 }}>
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">
            {wrapperCopy.uploadHelp}
          </Typography>
          <Button variant="outlined" onClick={() => void choose()} disabled={busy}>
            {wrapperCopy.chooseLocalInput}
          </Button>
          <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
            {sourcePaths[0] ?? wrapperCopy.notSelected}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {wrapperCopy.uploadDestination(destinationDirectory ?? '')}
          </Typography>
          {job && ['queued', 'uploading', 'verifying'].includes(job.status) && (
            <LinearProgress variant="determinate" value={Math.min(100, percent)} />
          )}
          {error && <Alert severity="error">{localizeWrapperMessage(error)}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {job && ['queued', 'uploading', 'verifying'].includes(job.status) && (
          <Button color="error" onClick={() => void cancel()}>
            {wrapperCopy.cancelUpload}
          </Button>
        )}
        <Button onClick={onClose} disabled={busy}>
          {resourceUi.close}
        </Button>
        <Button
          variant="contained"
          onClick={() => void upload()}
          disabled={busy || sourcePaths.length !== 1}
        >
          {busy ? wrapperCopy.uploading : wrapperCopy.uploadAndBind}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
