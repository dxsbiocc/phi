import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  Divider,
  IconButton,
  LinearProgress,
  Stack,
  Typography
} from '@mui/material'

import type {
  AppUpdateAsset,
  AppUpdateCheck,
  AppUpdateDownloadState,
  AppUpdateInstallMode
} from '../../../shared/appUpdateTypes'
import { PhiIcons } from '../icons'
import { appUpdateCopy } from '../lib/appUpdateCopy'
import { useAppUpdateDownload } from '../lib/appUpdateStore'
import { getUiLocale, useUiLanguage } from '../lib/i18n'
import MarkdownContent from './MarkdownContent'
import { OverlayScroll } from './OverlayScroll'

const CloseIcon = PhiIcons.action.close
const NOTES_MAX_HEIGHT = 'min(46vh, 420px)'

function formatUpdateBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  const kb = bytes / 1024
  if (kb >= 1) return `${Math.round(kb)} KB`
  return `${Math.round(bytes)} B`
}

function formatPublishedDate(publishedAt: string | undefined, locale: string): string | null {
  if (!publishedAt) return null
  const parsed = new Date(publishedAt)
  if (Number.isNaN(parsed.getTime())) return null
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }).format(parsed)
  } catch {
    return publishedAt.slice(0, 10)
  }
}

function resolveActiveState(
  state: AppUpdateDownloadState,
  version: string | undefined
): AppUpdateDownloadState {
  if (version && state.stage !== 'idle' && (!state.version || state.version === version)) {
    return state
  }
  return { stage: 'idle', downloadedBytes: 0, totalBytes: 0, percent: null }
}

function formatDownloadProgressText(state: AppUpdateDownloadState): string {
  if (state.totalBytes <= 0) return formatUpdateBytes(state.downloadedBytes)
  const suffix = state.percent !== null ? ` (${state.percent}%)` : ''
  return `${formatUpdateBytes(state.downloadedBytes)} / ${formatUpdateBytes(state.totalBytes)}${suffix}`
}

function AppUpdateHeader({ update }: { update: AppUpdateCheck }): React.JSX.Element {
  const publishedDate = formatPublishedDate(update.publishedAt, getUiLocale())
  const title = update.releaseTitle ?? `Phi v${update.latestVersion ?? ''}`
  return (
    <Box sx={{ pr: 4 }}>
      <Typography variant="overline" color="text.secondary">
        {appUpdateCopy.applicationUpdate}
      </Typography>
      <Stack
        direction="row"
        spacing={1.5}
        useFlexGap
        sx={{ alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        <Chip
          size="small"
          color="primary"
          variant="outlined"
          label={`${update.currentVersion} → ${update.latestVersion ?? ''}`}
          sx={{ fontFamily: 'var(--font-mono)' }}
        />
        {publishedDate ? (
          <Typography variant="caption" color="text.secondary">
            {publishedDate}
          </Typography>
        ) : null}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
        {appUpdateCopy.dataPreservedNotice}
      </Typography>
    </Box>
  )
}

function AppUpdateNotesSection({
  releaseNotes,
  onOpenGitHub
}: {
  releaseNotes?: string
  onOpenGitHub: () => void
}): React.JSX.Element {
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, flex: 1 }}>
          {appUpdateCopy.whatsNew}
        </Typography>
        <Button size="small" variant="text" onClick={onOpenGitHub}>
          {appUpdateCopy.viewOnGitHub}
        </Button>
      </Stack>
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
        {releaseNotes ? (
          <OverlayScroll
            sx={{ maxHeight: NOTES_MAX_HEIGHT }}
            contentSx={{ overscrollBehavior: 'contain' }}
          >
            <Box
              sx={{
                px: 2,
                py: 1.75,
                fontSize: '0.875rem',
                lineHeight: 1.55,
                '& > :first-of-type': { mt: 0 },
                '& > :last-of-type': { mb: 0 }
              }}
            >
              <MarkdownContent text={releaseNotes} />
            </Box>
          </OverlayScroll>
        ) : (
          <Box sx={{ px: 2, py: 1.5 }}>
            <Typography variant="body2" color="text.secondary">
              {appUpdateCopy.noReleaseNotes}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  )
}

function DownloadingFooter({
  state,
  onCancel
}: {
  state: AppUpdateDownloadState
  onCancel: () => void
}): React.JSX.Element {
  const label = state.assetName
    ? appUpdateCopy.downloadingAsset(state.assetName)
    : appUpdateCopy.downloadingGeneric
  return (
    <Stack spacing={1} data-phi-app-update-stage="downloading">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
          {label}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontFamily: 'var(--font-mono)', flexShrink: 0 }}
        >
          {formatDownloadProgressText(state)}
        </Typography>
      </Stack>
      <LinearProgress
        variant={state.percent !== null ? 'determinate' : 'indeterminate'}
        value={state.percent ?? undefined}
        sx={{ height: 6, borderRadius: 999 }}
      />
      <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
        <Button size="small" variant="outlined" onClick={onCancel}>
          {appUpdateCopy.cancelDownload}
        </Button>
      </Stack>
    </Stack>
  )
}

function DownloadedFooter({
  state,
  installMode,
  onInstall
}: {
  state: AppUpdateDownloadState
  installMode: AppUpdateInstallMode
  onInstall: () => void
}): React.JSX.Element {
  const isAutoReplace = installMode === 'auto-replace'
  return (
    <Stack spacing={1.25} data-phi-app-update-stage="downloaded">
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip size="small" color="success" label={appUpdateCopy.checksumVerified} />
        {state.assetName ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontFamily: 'var(--font-mono)' }}
          >
            {state.assetName}
          </Typography>
        ) : null}
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {isAutoReplace ? appUpdateCopy.readyAutoReplaceHint : appUpdateCopy.readyOpenInstallerHint}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
        <Button variant="contained" onClick={onInstall}>
          {isAutoReplace ? appUpdateCopy.restartAndInstall : appUpdateCopy.openInstallerAndQuit}
        </Button>
      </Stack>
    </Stack>
  )
}

function AppUpdateFooter({
  state,
  asset,
  installMode,
  onStartDownload,
  onCancelDownload,
  onInstall,
  onOpenGitHub
}: {
  state: AppUpdateDownloadState
  asset?: AppUpdateAsset
  installMode: AppUpdateInstallMode
  onStartDownload: () => void
  onCancelDownload: () => void
  onInstall: () => void
  onOpenGitHub: () => void
}): React.JSX.Element {
  if (state.stage === 'downloading') {
    return <DownloadingFooter state={state} onCancel={onCancelDownload} />
  }
  if (state.stage === 'verifying') {
    return (
      <Stack spacing={1} data-phi-app-update-stage="verifying">
        <Typography variant="body2">{appUpdateCopy.verifyingChecksum}</Typography>
        <LinearProgress sx={{ height: 6, borderRadius: 999 }} />
      </Stack>
    )
  }
  if (state.stage === 'downloaded') {
    return <DownloadedFooter state={state} installMode={installMode} onInstall={onInstall} />
  }
  if (state.stage === 'installing') {
    return (
      <Stack
        direction="row"
        spacing={1.25}
        data-phi-app-update-stage="installing"
        sx={{ alignItems: 'center', justifyContent: 'flex-end' }}
      >
        <CircularProgress size={16} />
        <Typography variant="body2">{appUpdateCopy.launchingInstaller}</Typography>
      </Stack>
    )
  }
  if (state.stage === 'error') {
    return (
      <Stack spacing={1.25} data-phi-app-update-stage="error">
        <Alert severity="error">{state.error ?? appUpdateCopy.updateFailed}</Alert>
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
          <Button variant="outlined" onClick={onOpenGitHub}>
            {appUpdateCopy.downloadInBrowser}
          </Button>
          {asset ? (
            <Button variant="contained" onClick={onStartDownload}>
              {appUpdateCopy.retryDownload}
            </Button>
          ) : null}
        </Stack>
      </Stack>
    )
  }
  return (
    <Stack
      direction="row"
      spacing={1}
      data-phi-app-update-stage="idle"
      sx={{ justifyContent: 'flex-end', alignItems: 'center' }}
    >
      {asset ? (
        <Button variant="contained" onClick={onStartDownload}>
          {asset.size > 0
            ? appUpdateCopy.downloadUpdateWithSize(formatUpdateBytes(asset.size))
            : appUpdateCopy.downloadUpdate}
        </Button>
      ) : (
        <Button variant="contained" onClick={onOpenGitHub}>
          {appUpdateCopy.openReleasesPage}
        </Button>
      )}
    </Stack>
  )
}

export function AppUpdateDialog({
  open,
  update,
  downloadStateOverride,
  onClose
}: {
  open: boolean
  update: AppUpdateCheck | null
  downloadStateOverride?: AppUpdateDownloadState
  onClose: () => void
}): React.JSX.Element {
  useUiLanguage()
  const {
    downloadState: liveDownloadState,
    startDownload,
    cancelDownload,
    installUpdate
  } = useAppUpdateDownload()
  const activeState = resolveActiveState(
    downloadStateOverride ?? liveDownloadState,
    update?.latestVersion
  )
  const asset = update?.asset
  const installMode = activeState.installMode ?? asset?.installMode ?? 'manual'

  const openReleasesInBrowser = (): void => {
    if (!update?.releasesUrl) return
    void window.api?.openAppReleasesPage?.(update.releasesUrl).catch(() => undefined)
  }

  return (
    <Dialog
      open={open && update !== null && update.status === 'available'}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      data-phi-app-update-dialog="true"
    >
      {update && update.status === 'available' ? (
        <Stack spacing={2} sx={{ p: 3, position: 'relative' }}>
          <IconButton
            size="small"
            aria-label={appUpdateCopy.close}
            onClick={onClose}
            sx={{ position: 'absolute', top: 12, right: 12 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
          <AppUpdateHeader update={update} />
          <Divider />
          <AppUpdateNotesSection
            releaseNotes={update.releaseNotes}
            onOpenGitHub={openReleasesInBrowser}
          />
          <Divider />
          <AppUpdateFooter
            state={activeState}
            asset={asset}
            installMode={installMode}
            onStartDownload={() => void startDownload()}
            onCancelDownload={() => void cancelDownload()}
            onInstall={() => void installUpdate()}
            onOpenGitHub={openReleasesInBrowser}
          />
        </Stack>
      ) : null}
    </Dialog>
  )
}
