import { useCallback, useEffect, useState } from 'react'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography
} from '@mui/material'
import type {
  GithubSourceSummary,
  GithubSourceUpdateCheck
} from '../../../../../shared/githubSourceTypes'

function errorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).replace(
    /^Error invoking remote method '[^']+': (?:[^:]+: )?/,
    ''
  )
}

function diffText(update: Extract<GithubSourceUpdateCheck, { changed: true }>): string[] {
  return [
    ...update.diff.added.map((entry) => `新增 ${entry.id}@${entry.version}`),
    ...update.diff.removed.map((entry) => `移除 ${entry.id}@${entry.version}`),
    ...update.diff.changed.map(
      (entry) => `更新 ${entry.id}: ${entry.fromVersion} → ${entry.toVersion}`
    )
  ]
}

export function McpSourcesPanel({
  open,
  onClose,
  onChanged
}: {
  open: boolean
  onClose: () => void
  onChanged: () => Promise<void> | void
}): React.JSX.Element {
  const [sources, setSources] = useState<GithubSourceSummary[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingUpdate, setPendingUpdate] = useState<Extract<
    GithubSourceUpdateCheck,
    { changed: true }
  > | null>(null)
  const [pendingRemove, setPendingRemove] = useState<GithubSourceSummary | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setSources(await window.api.listGithubSources())
  }, [])
  useEffect(() => {
    if (!open) return
    let active = true
    void window.api
      .listGithubSources()
      .then((entries) => {
        if (active) setSources(entries)
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause))
      })
    return () => {
      active = false
    }
  }, [open])

  async function check(source: GithubSourceSummary): Promise<void> {
    setBusy(source.id)
    setError(null)
    setNotice(null)
    try {
      const update = await window.api.checkGithubSourceUpdate(source.id)
      if (update.changed) setPendingUpdate(update)
      else setNotice(`${source.repo} 已是最新版本`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function apply(): Promise<void> {
    if (!pendingUpdate) return
    setBusy(pendingUpdate.source.id)
    try {
      await window.api.applyGithubSourceUpdate({
        id: pendingUpdate.source.id,
        sha: pendingUpdate.sha
      })
      setPendingUpdate(null)
      await load()
      await onChanged()
      setNotice('软件源已更新')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function remove(): Promise<void> {
    if (!pendingRemove) return
    setBusy(pendingRemove.id)
    try {
      await window.api.removeGithubSource(pendingRemove.id)
      setPendingRemove(null)
      await load()
      await onChanged()
      setNotice('软件源已移除；已安装的连接器会保留')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
        <DialogTitle>管理软件源</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {error && <Alert severity="error">{error}</Alert>}
            {notice && <Alert severity="info">{notice}</Alert>}
            {sources.length === 0 ? (
              <Typography color="text.secondary">尚未添加 GitHub 软件源</Typography>
            ) : (
              <List disablePadding>
                {sources.map((source, index) => (
                  <ListItem
                    key={source.id}
                    disableGutters
                    divider={index < sources.length - 1}
                    secondaryAction={
                      <Stack direction="row" spacing={1}>
                        <Button disabled={busy !== null} onClick={() => void check(source)}>
                          更新
                        </Button>
                        <Button
                          color="error"
                          disabled={busy !== null}
                          onClick={() => setPendingRemove(source)}
                        >
                          移除
                        </Button>
                      </Stack>
                    }
                  >
                    <ListItemText
                      primary={source.repo}
                      secondary={`${source.ref ? `${source.ref} · ` : ''}${source.sha.slice(0, 7)}`}
                    />
                  </ListItem>
                ))}
              </List>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy !== null} onClick={onClose}>
            完成
          </Button>
        </DialogActions>
      </Dialog>
      <ConfirmationDialog open={Boolean(pendingUpdate)} onClose={() => setPendingUpdate(null)}>
        <DialogTitle>确认更新软件源</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <Typography>
              {pendingUpdate?.source.repo} → {pendingUpdate?.sha.slice(0, 7)}
            </Typography>
            <Divider />
            {(pendingUpdate ? diffText(pendingUpdate) : []).map((line) => (
              <Typography key={line}>{line}</Typography>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy !== null} onClick={() => setPendingUpdate(null)}>
            取消
          </Button>
          <Button variant="contained" disabled={busy !== null} onClick={() => void apply()}>
            确认更新
          </Button>
        </DialogActions>
      </ConfirmationDialog>
      <ConfirmationDialog open={Boolean(pendingRemove)} onClose={() => setPendingRemove(null)}>
        <DialogTitle>移除软件源？</DialogTitle>
        <DialogContent>
          <Alert severity="warning">软件源会从目录中移除，但已安装的连接器会保留。</Alert>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy !== null} onClick={() => setPendingRemove(null)}>
            取消
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={busy !== null}
            onClick={() => void remove()}
          >
            移除
          </Button>
        </DialogActions>
      </ConfirmationDialog>
    </>
  )
}
