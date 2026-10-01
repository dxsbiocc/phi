import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import { PhiIcons } from '../../../icons'
import type { PluginCatalogItem } from '../../../types'

const DownloadIcon = PhiIcons.action.download
const ExtensionIcon = PhiIcons.entity.plugin
const OpenInNewIcon = PhiIcons.action.openExternal

export type DeveloperExtensionDetailProps = {
  selectedExtension: PluginCatalogItem | null
  busySource: string | null
  operationError: string | null
  onInstall: (source: string) => void
  onRemove: (source: string) => void
}

const kindLabels: Record<PluginCatalogItem['kind'], string> = {
  extension: 'Extension',
  skill: 'Skill',
  prompt: 'Prompt',
  theme: 'Theme',
  package: 'Package'
}

export function DeveloperExtensionDetail({
  selectedExtension,
  busySource,
  operationError,
  onInstall,
  onRemove
}: DeveloperExtensionDetailProps): React.JSX.Element {
  const [pendingAction, setPendingAction] = useState<{
    type: 'install' | 'remove'
    extension: PluginCatalogItem
  } | null>(null)
  const pendingActionTitle = pendingAction?.type === 'install' ? '安装开发者扩展' : '卸载开发者扩展'

  const confirmPendingAction = (): void => {
    if (!pendingAction) return
    if (pendingAction.type === 'install') {
      onInstall(pendingAction.extension.source)
    } else {
      onRemove(pendingAction.extension.source)
    }
    setPendingAction(null)
  }

  return (
    <>
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
        {selectedExtension ? (
          <Box sx={{ px: { xs: 2.5, md: 3.5 }, py: 3 }}>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
              <Box
                sx={{
                  width: 72,
                  height: 72,
                  borderRadius: 1,
                  bgcolor: selectedExtension.installed ? 'success.main' : 'primary.main',
                  color: '#FFFFFF',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0
                }}
              >
                <ExtensionIcon />
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="h4" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
                  {selectedExtension.name}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {selectedExtension.author ? `${selectedExtension.author} · ` : ''}
                  {kindLabels[selectedExtension.kind]}
                </Typography>
                <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
                  {selectedExtension.installed ? (
                    <Chip size="small" color="success" label="已安装" />
                  ) : (
                    <Chip size="small" label="未安装" />
                  )}
                  {selectedExtension.downloads ? (
                    <Chip size="small" variant="outlined" label={selectedExtension.downloads} />
                  ) : null}
                  {selectedExtension.updated ? (
                    <Chip size="small" variant="outlined" label={selectedExtension.updated} />
                  ) : null}
                </Stack>
              </Box>
            </Stack>

            <Stack direction="row" spacing={1.25} sx={{ mt: 3, flexWrap: 'wrap', rowGap: 1 }}>
              {selectedExtension.installed ? (
                <Button
                  variant="outlined"
                  color="error"
                  disabled={busySource === selectedExtension.source}
                  onClick={() => setPendingAction({ type: 'remove', extension: selectedExtension })}
                >
                  卸载
                </Button>
              ) : (
                <Button
                  variant="contained"
                  startIcon={<DownloadIcon />}
                  disabled={busySource === selectedExtension.source}
                  onClick={() =>
                    setPendingAction({ type: 'install', extension: selectedExtension })
                  }
                >
                  安装
                </Button>
              )}
              <Button
                component="a"
                href={selectedExtension.homepageUrl}
                target="_blank"
                rel="noreferrer"
                variant="outlined"
                endIcon={<OpenInNewIcon />}
              >
                pi.dev
              </Button>
              <Button
                component="a"
                href={selectedExtension.npmUrl}
                target="_blank"
                rel="noreferrer"
                variant="outlined"
                endIcon={<OpenInNewIcon />}
              >
                npm
              </Button>
            </Stack>

            {busySource === selectedExtension.source ? (
              <Stack direction="row" spacing={1.5} sx={{ mt: 3, alignItems: 'center' }}>
                <CircularProgress size={18} />
                <Typography variant="body2" color="text.secondary">
                  正在同步开发者扩展
                </Typography>
              </Stack>
            ) : null}

            {operationError ? (
              <Alert severity="error" sx={{ mt: 3 }}>
                {operationError}
              </Alert>
            ) : null}

            <Divider sx={{ my: 4 }} />

            <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
              说明
            </Typography>
            <Typography variant="body1" sx={{ maxWidth: 720 }}>
              {selectedExtension.description || '此开发者扩展来自 Pi 扩展目录。'}
            </Typography>

            <Typography variant="h6" sx={{ fontWeight: 700, mt: 4, mb: 1 }}>
              安装源
            </Typography>
            <Tooltip title="Pi SDK 会使用这个源安装开发者扩展">
              <Box
                component="code"
                sx={{
                  display: 'block',
                  width: 'fit-content',
                  maxWidth: '100%',
                  px: 1.25,
                  py: 1,
                  borderRadius: 1,
                  bgcolor: 'action.hover',
                  overflowWrap: 'anywhere',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.88rem'
                }}
              >
                pi install {selectedExtension.source}
              </Box>
            </Tooltip>

            {selectedExtension.installedPath ? (
              <>
                <Typography variant="h6" sx={{ fontWeight: 700, mt: 4, mb: 1 }}>
                  本地路径
                </Typography>
                <Typography
                  component="code"
                  sx={{
                    display: 'block',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.84rem',
                    color: 'text.secondary',
                    overflowWrap: 'anywhere'
                  }}
                >
                  {selectedExtension.installedPath}
                </Typography>
              </>
            ) : null}
          </Box>
        ) : (
          <Stack
            spacing={1}
            sx={{ height: '100%', alignItems: 'center', justifyContent: 'center', py: 8 }}
          >
            <ExtensionIcon color="disabled" />
            <Typography color="text.secondary">没有找到开发者扩展</Typography>
          </Stack>
        )}
      </Box>

      <Dialog open={pendingAction !== null} onClose={() => setPendingAction(null)}>
        <DialogTitle>{pendingActionTitle}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            {pendingAction?.type === 'install'
              ? '确认通过 Pi runtime 安装这个开发者扩展源。'
              : '确认从 Pi runtime 移除这个开发者扩展源。'}
          </Typography>
          <Box
            component="code"
            sx={{
              display: 'block',
              maxWidth: 520,
              px: 1.25,
              py: 1,
              borderRadius: 1,
              bgcolor: 'action.hover',
              overflowWrap: 'anywhere',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.88rem'
            }}
          >
            {pendingAction?.extension.source}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingAction(null)}>取消</Button>
          <Button
            variant="contained"
            color={pendingAction?.type === 'remove' ? 'error' : 'primary'}
            onClick={confirmPendingAction}
          >
            确认
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
