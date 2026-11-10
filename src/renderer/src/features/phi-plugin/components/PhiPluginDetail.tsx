import { getUiLocale, useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { pluginCopy } from '../lib/pluginCopy'
import { VisualizationPanel } from '../../visualization/VisualizationPanel'
import { VisualizationViewSwitch } from '../../visualization/components/VisualizationViewSwitch'
import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  Switch,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import { GoSync } from 'react-icons/go'

import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import { EnvironmentBuildConfirmDialog } from '../../../components/EnvironmentBuildConfirmDialog'
import { PhiIcons } from '../../../icons'
import { ResourceIcon } from '../../../components/ResourceIcon'
import type { PhiPluginDisplayItem, PhiPluginEnvironmentStatus } from '../hooks/usePhiPlugins'
import { errorMessage } from '../../../../../shared/errorCodes'
import { requestPhiPluginEnvironmentBuild } from '../lib/environmentBuild'
import type { PhiPluginCatalogAction, PhiPluginCatalogEntry } from '../lib/phiPluginCatalog'
import { PhiPluginCatalogPreview, PluginSummary } from './PhiPluginCatalogPreview'
import { PhiPluginComponentDetails } from './PhiPluginComponentDetails'
import { PhiPluginEnvironmentDetails } from './PhiPluginEnvironmentDetails'

export type PhiPluginDetailProps = {
  plugin: PhiPluginDisplayItem | null
  busyPluginId: string | null
  error: string | null
  notice: string | null
  onClearError: () => void
  onClearNotice: () => void
  onRefresh: () => Promise<void>
  onSetEnabled: (plugin: PhiPluginDisplayItem, enabled: boolean) => Promise<boolean>
  onUninstall: (plugin: PhiPluginDisplayItem) => Promise<boolean>
  /** Catalog preview when the plugin is not installed yet (or only registry metadata exists). */
  catalogEntry?: PhiPluginCatalogEntry | null
  catalogAction?: PhiPluginCatalogAction
  installBusy?: boolean
  onInstall?: () => void
}

export function PhiPluginDetail({
  plugin,
  busyPluginId,
  error,
  notice,
  onClearError,
  onClearNotice,
  onRefresh,
  onSetEnabled,
  onUninstall,
  catalogEntry = null,
  catalogAction = 'install',
  installBusy = false,
  onInstall
}: PhiPluginDetailProps): React.JSX.Element {
  useUiLanguage()

  const [pendingUninstall, setPendingUninstall] = useState<PhiPluginDisplayItem | null>(null)
  const [segment, setSegment] = useState<'overview' | 'templates'>('overview')
  const showTemplates = plugin?.id === 'visualization' && segment === 'templates'
  const [pendingBuildState, setPendingBuild] = useState<{
    pluginId: string
    environment: PhiPluginEnvironmentStatus
  } | null>(null)
  const [busyEnvironmentState, setBusyEnvironment] = useState<{
    pluginId: string
    envId: string
    kind: 'build' | 'rebuild'
  } | null>(null)
  const [environmentErrorState, setEnvironmentActionError] = useState<{
    pluginId: string
    message: string
  } | null>(null)
  const busy = plugin !== null && busyPluginId === plugin.id
  const pendingBuild =
    pendingBuildState && pendingBuildState.pluginId === plugin?.id
      ? pendingBuildState.environment
      : null
  const busyEnvironment =
    busyEnvironmentState && busyEnvironmentState.pluginId === plugin?.id
      ? busyEnvironmentState
      : null
  const environmentActionError =
    environmentErrorState && environmentErrorState.pluginId === plugin?.id
      ? environmentErrorState.message
      : null
  const catalogPreview = plugin === null && catalogEntry !== null

  async function confirmUninstall(): Promise<void> {
    if (!pendingUninstall) return
    if (await onUninstall(pendingUninstall)) setPendingUninstall(null)
  }

  async function confirmBuild(): Promise<void> {
    if (!plugin || !pendingBuild) return
    setEnvironmentActionError(null)
    setBusyEnvironment({
      pluginId: plugin.id,
      envId: pendingBuild.envId ?? pendingBuild.ref,
      kind: 'build'
    })
    try {
      const result = await requestPhiPluginEnvironmentBuild(window.api, plugin.id, pendingBuild)
      setBusyEnvironment({ pluginId: plugin.id, envId: result.envId, kind: 'build' })
      setPendingBuild(null)
      await onRefresh()
    } catch (cause) {
      setEnvironmentActionError({
        pluginId: plugin.id,
        message: pluginCopy.buildFailed(errorMessage(cause))
      })
      setBusyEnvironment(null)
      setPendingBuild(null)
    }
  }

  async function rebuildEnvironment(environment: PhiPluginEnvironmentStatus): Promise<void> {
    if (!environment.envId) return
    setEnvironmentActionError(null)
    if (!plugin) return
    setBusyEnvironment({
      pluginId: plugin.id,
      envId: environment.envId,
      kind: 'rebuild'
    })
    try {
      await window.api.rebuildManagedEnvironment(environment.envId)
      await onRefresh()
    } catch (cause) {
      setEnvironmentActionError({
        pluginId: plugin.id,
        message: pluginCopy.rebuildFailed(errorMessage(cause))
      })
    } finally {
      setBusyEnvironment(null)
    }
  }

  return (
    <Box
      component="main"
      data-phi-plugin-detail="true"
      data-phi-plugin-detail-mode={catalogPreview ? 'catalog' : plugin ? 'installed' : 'empty'}
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: showTemplates ? 'hidden' : 'auto',
        // Classic scrollbars are 12px. Keep that gutter in both modes so the header
        // stays put when switching overview and gallery, matching skill and connector details.
        scrollbarGutter: 'stable'
      }}
    >
      <Box
        sx={{
          width: '100%',
          maxWidth: 940,
          mx: 'auto',
          px: { xs: 2.5, md: 4 },
          pt: 3.5,
          pb: showTemplates ? 2 : 3.5,
          flexShrink: 0
        }}
      >
        <Stack spacing={2.5}>
          {error ? (
            <Alert severity="error" variant="outlined" onClose={onClearError}>
              {error}
            </Alert>
          ) : null}
          {notice ? (
            <Alert severity="success" variant="outlined" onClose={onClearNotice}>
              {notice}
            </Alert>
          ) : null}

          {plugin ? (
            <>
              <Box>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <Box
                    sx={{
                      width: 58,
                      height: 58,
                      flexShrink: 0,
                      borderRadius: 2,
                      display: 'grid',
                      placeItems: 'center',
                      color: plugin.enabled ? 'primary.main' : 'text.disabled',
                      bgcolor: (theme) =>
                        alpha(
                          plugin.enabled ? theme.palette.primary.main : theme.palette.text.disabled,
                          theme.palette.mode === 'dark' ? 0.18 : 0.09
                        )
                    }}
                  >
                    <ResourceIcon icon={plugin.icon} kind="plugin" size={58} fallbackSize={30} />
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Stack
                      direction={{ xs: 'column', md: 'row' }}
                      spacing={2}
                      sx={{ alignItems: { md: 'flex-start' } }}
                    >
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="h4" sx={{ fontWeight: 750 }}>
                          {plugin.title}
                        </Typography>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{
                            mt: 0.25,
                            fontFamily: 'var(--font-mono)',
                            overflowWrap: 'anywhere'
                          }}
                        >
                          {plugin.id} · v{plugin.version}
                        </Typography>
                      </Box>
                      <Stack
                        direction="row"
                        spacing={1.5}
                        sx={{ alignItems: 'center', alignSelf: 'flex-start' }}
                      >
                        {plugin.id === 'visualization' ? (
                          <>
                            <VisualizationViewSwitch segment={segment} onChange={setSegment} />
                            <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
                          </>
                        ) : null}
                        {catalogAction === 'update' && onInstall ? (
                          <IconButton
                            aria-label={pluginCopy.updateNamed(plugin.title)}
                            title={pluginCopy.updateNamed(plugin.title)}
                            size="small"
                            disabled={installBusy || busyPluginId !== null}
                            onClick={onInstall}
                            sx={{
                              width: 34,
                              height: 34,
                              p: 0,
                              display: 'grid',
                              placeItems: 'center',
                              flexShrink: 0,
                              border: '1px solid',
                              borderColor: 'divider',
                              borderRadius: 1.5
                            }}
                          >
                            {installBusy ? (
                              <CircularProgress size={18} />
                            ) : (
                              <GoSync size={18} aria-hidden="true" />
                            )}
                          </IconButton>
                        ) : null}
                        <Typography variant="body2" color="text.secondary">
                          {resourceUi.enable}
                        </Typography>
                        <Tooltip
                          title={
                            plugin.enabled ? pluginCopy.disablePlugin : pluginCopy.enablePlugin
                          }
                        >
                          <span>
                            <Switch
                              checked={plugin.enabled}
                              disabled={busyPluginId !== null}
                              slotProps={{
                                input: {
                                  'aria-label': `${plugin.enabled ? resourceUi.disable : resourceUi.enable} ${plugin.title}`
                                }
                              }}
                              onChange={(_event, checked) => void onSetEnabled(plugin, checked)}
                            />
                          </span>
                        </Tooltip>
                        <Button
                          color="error"
                          variant="text"
                          disabled={busyPluginId !== null}
                          startIcon={
                            busy ? (
                              <CircularProgress size={14} color="inherit" />
                            ) : (
                              <PhiIcons.action.delete size={16} />
                            )
                          }
                          onClick={() => setPendingUninstall(plugin)}
                        >
                          {resourceUi.uninstall}
                        </Button>
                      </Stack>
                    </Stack>
                  </Box>
                </Stack>
                <PluginSummary text={plugin.summary} />
              </Box>

              {showTemplates ? null : (
                <>
                  <Divider />
                  <PhiPluginComponentDetails plugin={plugin} />

                  <Divider />
                  <PhiPluginEnvironmentDetails
                    environments={plugin.environmentStatuses}
                    busyEnvironment={busyEnvironment}
                    busyPluginId={busyPluginId}
                    actionError={environmentActionError}
                    onDismissError={() => setEnvironmentActionError(null)}
                    onBuild={(environment) => setPendingBuild({ pluginId: plugin.id, environment })}
                    onRebuild={(environment) => void rebuildEnvironment(environment)}
                  />

                  <Divider />
                  <Stack spacing={0.75}>
                    <Typography variant="body2" color="text.secondary">
                      {pluginCopy.installedAt(
                        new Date(plugin.installedAt).toLocaleString(getUiLocale())
                      )}
                    </Typography>
                    <Typography
                      component="code"
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}
                    >
                      {plugin.directory}
                    </Typography>
                  </Stack>
                </>
              )}
            </>
          ) : catalogPreview && catalogEntry ? (
            <PhiPluginCatalogPreview
              entry={catalogEntry}
              action={catalogAction}
              installBusy={installBusy}
              onInstall={onInstall}
            />
          ) : (
            <Stack spacing={1} sx={{ alignItems: 'center', textAlign: 'center', py: 12 }}>
              <PhiIcons.entity.plugin color="disabled" sx={{ fontSize: 42 }} />
              <Typography variant="h6">{pluginCopy.selectPlugin}</Typography>
              <Typography variant="body2" color="text.secondary">
                {pluginCopy.legacyTab}
              </Typography>
            </Stack>
          )}
        </Stack>
      </Box>
      {showTemplates ? <VisualizationPanel /> : null}

      <ConfirmationDialog
        open={pendingUninstall !== null}
        onClose={busyPluginId ? undefined : () => setPendingUninstall(null)}
      >
        <DialogTitle>
          {pluginCopy.uninstallTitle(pendingUninstall?.title ?? resourceUi.plugin)}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={1.25}>
            <DialogContentText>{pluginCopy.uninstallDescription}</DialogContentText>
            {pendingUninstall?.source === 'bundled' ? (
              <Alert severity="warning" variant="outlined">
                {pluginCopy.bundledUninstallNotice}
              </Alert>
            ) : null}
            <Typography component="code" variant="caption" sx={{ fontFamily: 'var(--font-mono)' }}>
              {pendingUninstall?.id} · v{pendingUninstall?.version}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={Boolean(busyPluginId)} onClick={() => setPendingUninstall(null)}>
            {resourceUi.cancel}
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={Boolean(busyPluginId)}
            onClick={() => void confirmUninstall()}
          >
            {busyPluginId ? pluginCopy.uninstalling : pluginCopy.confirmUninstall}
          </Button>
        </DialogActions>
      </ConfirmationDialog>
      <EnvironmentBuildConfirmDialog
        environment={
          pendingBuild
            ? { ref: pendingBuild.ref, label: pendingBuild.name, estimate: pendingBuild.estimate }
            : null
        }
        working={Boolean(busyEnvironment)}
        onClose={() => setPendingBuild(null)}
        onConfirm={() => void confirmBuild()}
      />
    </Box>
  )
}
