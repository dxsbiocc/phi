import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'

import type { PhiPluginInstallPreview } from '../../../../shared/phiPluginTypes'
import { PhiIcons } from '../../icons'
import { PhiPluginsCatalog } from './components/PhiPluginsCatalog'
import { PhiPluginPackageCatalog } from './components/PhiPluginPackageCatalog'
import { usePhiPlugins, type PhiPluginDisplayItem } from './hooks/usePhiPlugins'
import { formatPhiPluginProblems, isSemanticUpgrade } from './lib/phiPlugins'

const FolderIcon = PhiIcons.entity.folder
const RefreshIcon = PhiIcons.action.refresh

function installIsUpgrade(preview: PhiPluginInstallPreview): boolean {
  return (
    preview.action === 'upgrade' || isSemanticUpgrade(preview.installedVersion, preview.version)
  )
}

function pluginDisplayName(preview: PhiPluginInstallPreview): string {
  return preview.title?.trim() || preview.id?.trim() || '这个插件'
}

export function PhiPluginsView(): React.JSX.Element {
  const {
    plugins,
    loading,
    busyPluginId,
    error,
    notice,
    refresh,
    installFromDirectory,
    setEnabled,
    uninstall,
    showError,
    clearError,
    clearNotice
  } = usePhiPlugins()
  const [pickingDirectory, setPickingDirectory] = useState(false)
  const [pendingInstall, setPendingInstall] = useState<PhiPluginInstallPreview | null>(null)
  const [pendingUninstall, setPendingUninstall] = useState<PhiPluginDisplayItem | null>(null)
  const installWorking = busyPluginId === '__install__'

  const choosePluginDirectory = async (): Promise<void> => {
    setPickingDirectory(true)
    clearError()
    clearNotice()
    try {
      const path = await window.api.pickPhiPluginDirectory()
      if (!path) return
      const preview = await window.api.previewPhiPluginDirectory(path)
      if (!preview.ok) {
        showError(`插件目录验证失败：${formatPhiPluginProblems(preview.problems)}`)
        return
      }
      if (preview.action === 'same-or-older') {
        const installed = preview.installedVersion
          ? `已安装版本为 ${preview.installedVersion}，`
          : ''
        showError(`${installed}请选择版本更高的插件目录进行升级。`)
        return
      }
      setPendingInstall(preview)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      showError(`无法读取插件目录：${message}`)
    } finally {
      setPickingDirectory(false)
    }
  }

  const confirmInstall = async (): Promise<void> => {
    const preview = pendingInstall
    if (!preview) return
    const upgrade = installIsUpgrade(preview)
    const succeeded = await installFromDirectory(preview.path, upgrade ? '插件升级' : '插件安装')
    if (succeeded) setPendingInstall(null)
  }

  const confirmUninstall = async (): Promise<void> => {
    const plugin = pendingUninstall
    if (!plugin) return
    const succeeded = await uninstall(plugin)
    if (succeeded) setPendingUninstall(null)
  }

  return (
    <Box
      component="main"
      data-phi-plugins-view="true"
      sx={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%', overflow: 'auto' }}
    >
      <Box sx={{ width: '100%', maxWidth: 1180, mx: 'auto', px: { xs: 2.5, md: 4 }, py: 3.5 }}>
        <Stack spacing={2.5}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{
              alignItems: { xs: 'stretch', sm: 'flex-start' },
              justifyContent: 'space-between'
            }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h4" sx={{ fontWeight: 750 }}>
                插件
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 700 }}>
                管理 Phi 插件提供的智能体、技能、脚本工具和隔离环境。可从本地目录安装符合
                phi-package.yaml 合同的插件。
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
              <Button
                variant="outlined"
                disabled={loading || installWorking || pickingDirectory}
                startIcon={
                  loading ? <CircularProgress size={15} color="inherit" /> : <RefreshIcon />
                }
                onClick={() => void refresh()}
              >
                刷新
              </Button>
              <Button
                variant="contained"
                disabled={installWorking || pickingDirectory}
                startIcon={
                  installWorking || pickingDirectory ? (
                    <CircularProgress size={15} color="inherit" />
                  ) : (
                    <FolderIcon />
                  )
                }
                onClick={() => void choosePluginDirectory()}
              >
                {pickingDirectory ? '读取目录中…' : installWorking ? '安装中…' : '从本地目录安装'}
              </Button>
            </Stack>
          </Stack>

          {error ? (
            <Alert
              severity="error"
              variant="outlined"
              onClose={clearError}
              sx={{ whiteSpace: 'pre-line' }}
            >
              {error}
            </Alert>
          ) : null}
          {notice ? (
            <Alert
              severity="success"
              variant="outlined"
              onClose={clearNotice}
              sx={{ whiteSpace: 'pre-line' }}
            >
              {notice}
            </Alert>
          ) : null}

          <PhiPluginPackageCatalog
            installedIds={new Set(plugins.map((plugin) => plugin.id))}
            onChanged={refresh}
          />

          <PhiPluginsCatalog
            plugins={plugins}
            loading={loading}
            busyPluginId={busyPluginId}
            onChooseDirectory={() => void choosePluginDirectory()}
            onSetEnabled={(plugin, enabled) => void setEnabled(plugin, enabled)}
            onRequestUninstall={setPendingUninstall}
          />
        </Stack>
      </Box>

      <Dialog
        open={pendingInstall !== null}
        onClose={installWorking ? undefined : () => setPendingInstall(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {pendingInstall && installIsUpgrade(pendingInstall) ? '升级插件？' : '安装插件？'}
        </DialogTitle>
        <DialogContent>
          {pendingInstall ? (
            <Stack spacing={1.5}>
              <DialogContentText>
                {installIsUpgrade(pendingInstall)
                  ? `将 ${pluginDisplayName(pendingInstall)} 从 ${pendingInstall.installedVersion ?? '当前版本'} 升级到 ${pendingInstall.version ?? '新版本'}。升级前请确认插件目录可信。`
                  : `将从这个本地目录安装 ${pluginDisplayName(pendingInstall)} ${pendingInstall.version ?? ''}。安装后插件默认可用。`}
              </DialogContentText>
              {pendingInstall.summary ? (
                <Typography variant="body2" color="text.secondary">
                  {pendingInstall.summary}
                </Typography>
              ) : null}
              <Typography
                component="code"
                variant="caption"
                sx={{
                  display: 'block',
                  p: 1.25,
                  borderRadius: 1,
                  bgcolor: 'action.hover',
                  fontFamily: 'var(--font-mono)',
                  overflowWrap: 'anywhere'
                }}
              >
                {pendingInstall.path}
              </Typography>
              {pendingInstall.problems.length > 0 ? (
                <Alert severity="warning" variant="outlined" sx={{ whiteSpace: 'pre-line' }}>
                  {formatPhiPluginProblems(pendingInstall.problems)}
                </Alert>
              ) : null}
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button disabled={installWorking} onClick={() => setPendingInstall(null)}>
            取消
          </Button>
          <Button
            variant="contained"
            disabled={installWorking}
            startIcon={installWorking ? <CircularProgress size={14} color="inherit" /> : undefined}
            onClick={() => void confirmInstall()}
          >
            {installWorking
              ? '处理中…'
              : pendingInstall && installIsUpgrade(pendingInstall)
                ? '确认升级'
                : '确认安装'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={pendingUninstall !== null}
        onClose={busyPluginId ? undefined : () => setPendingUninstall(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>卸载 {pendingUninstall?.title ?? '插件'}？</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25}>
            <DialogContentText>
              将移除此插件的智能体、技能、脚本工具和环境引用。仅由它使用且不再被引用的环境可以被清理。
            </DialogContentText>
            {pendingUninstall?.source === 'bundled' ? (
              <Alert severity="warning" variant="outlined">
                这是内置插件。卸载决定会被保留，Phi 下次启动时不会自动恢复它。
              </Alert>
            ) : null}
            <Typography
              component="code"
              variant="caption"
              sx={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}
            >
              {pendingUninstall?.id} · v{pendingUninstall?.version}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button disabled={Boolean(busyPluginId)} onClick={() => setPendingUninstall(null)}>
            取消
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={Boolean(busyPluginId)}
            startIcon={busyPluginId ? <CircularProgress size={14} color="inherit" /> : undefined}
            onClick={() => void confirmUninstall()}
          >
            {busyPluginId ? '卸载中…' : '确认卸载'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default PhiPluginsView
