import { useState } from 'react'
import {
  Alert,
  Box,
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
  TextField,
  Typography
} from '@mui/material'
import type {
  GithubLocalConnectorDraft,
  GithubSourcePreview,
  GithubSourceSummary
} from '../../../../../shared/githubSourceTypes'
import { githubImportUrlError } from '../lib/githubImportDraft'
import { McpProjectHintPanel } from './McpProjectHintPanel'

function message(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).replace(
    /^Error invoking remote method '[^']+': (?:[^:]+: )?/,
    ''
  )
}

export function McpGithubImportActions({
  preview,
  url,
  busy,
  onClose,
  onPreview,
  onImport,
  onUseLocalDraft
}: {
  preview: GithubSourcePreview | null
  url: string
  busy: 'preview' | 'import' | null
  onClose: () => void
  onPreview: () => void
  onImport: () => void
  onUseLocalDraft: (draft: GithubLocalConnectorDraft) => void
}): React.JSX.Element {
  return (
    <DialogActions>
      <Button disabled={busy !== null} onClick={onClose}>
        取消
      </Button>
      {!preview ? (
        <Button
          variant="contained"
          disabled={busy !== null || Boolean(githubImportUrlError(url))}
          onClick={onPreview}
        >
          {busy === 'preview' ? '正在预览…' : '预览'}
        </Button>
      ) : preview.packages.length > 0 ? (
        <Button variant="contained" disabled={busy !== null} onClick={onImport}>
          {busy === 'import' ? '正在导入…' : '导入'}
        </Button>
      ) : preview.localDraft ? (
        <Button
          variant="contained"
          disabled={busy !== null}
          onClick={() => onUseLocalDraft(preview.localDraft!)}
        >
          按本地 stdio 添加…
        </Button>
      ) : null}
    </DialogActions>
  )
}

export function McpGithubImportDialog({
  open,
  onClose,
  onImported,
  onUseLocalDraft
}: {
  open: boolean
  onClose: () => void
  onImported: (source: GithubSourceSummary) => Promise<void> | void
  onUseLocalDraft: (draft: GithubLocalConnectorDraft) => void
}): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [preview, setPreview] = useState<GithubSourcePreview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function loadPreview(): Promise<void> {
    const validation = githubImportUrlError(url)
    if (validation) {
      setError(validation)
      return
    }
    setBusy('preview')
    setError(null)
    setPreview(null)
    try {
      setPreview(await window.api.previewGithubSource(url.trim()))
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  async function importSource(): Promise<void> {
    if (!preview) return
    setBusy('import')
    setError(null)
    try {
      const source = await window.api.addGithubSource({ url: url.trim(), sha: preview.sha })
      await onImported(source)
      onClose()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        导入软件源
        {preview && preview.packages.length > 0 ? (
          <Typography component="div" variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            导入后，仓库里的连接器会出现在目录中，安装时仍需确认。
          </Typography>
        ) : null}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            autoFocus
            label="仓库地址"
            placeholder="https://github.com/owner/repo"
            value={url}
            disabled={busy !== null}
            onChange={(event) => {
              setUrl(event.target.value)
              setPreview(null)
              setError(null)
            }}
          />
          {error && <Alert severity="error">{error}</Alert>}
          {preview && (
            <Stack spacing={1.5}>
              <Box>
                <Typography sx={{ fontWeight: 700 }}>{preview.repo}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {preview.ref ? `引用 ${preview.ref} · ` : ''}提交 {preview.sha.slice(0, 7)}
                </Typography>
              </Box>
              {preview.packages.length === 0 && preview.projectHint ? (
                <McpProjectHintPanel hint={preview.projectHint} />
              ) : (
                <>
                  <Divider />
                  <List dense disablePadding>
                    {preview.packages.map((pkg) => (
                      <ListItem key={`${pkg.id}@${pkg.version}`} disableGutters>
                        <ListItemText
                          primary={`${pkg.title} · ${pkg.version}`}
                          secondary={`${pkg.publisher} · ${pkg.transport === 'stdio' ? '本地' : '远程'}`}
                        />
                      </ListItem>
                    ))}
                  </List>
                  {preview.skipped.map((item) => (
                    <Alert key={`${item.type}:${item.id ?? item.reason}`} severity="info">
                      {item.reason}
                    </Alert>
                  ))}
                  {preview.warnings.map((warning) => (
                    <Alert key={warning} severity="warning">
                      {warning}
                    </Alert>
                  ))}
                  <Alert severity="warning">
                    未签名·用户导入。安装连接器时才会运行其中的命令。
                  </Alert>
                </>
              )}
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <McpGithubImportActions
        preview={preview}
        url={url}
        busy={busy}
        onClose={onClose}
        onPreview={() => void loadPreview()}
        onImport={() => void importSource()}
        onUseLocalDraft={onUseLocalDraft}
      />
    </Dialog>
  )
}
