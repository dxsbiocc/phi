import {
  Box,
  Button,
  CircularProgress,
  Divider,
  IconButton,
  Skeleton,
  Stack,
  Typography
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import { GoPlus, GoSync } from 'react-icons/go'

import { ResourceIcon } from '../../../components/ResourceIcon'
import { useUiLanguage } from '../../../lib/i18n'
import type {
  PhiPluginCatalogDetail,
  PhiPluginCatalogDetailReason
} from '../../../../../shared/phiPluginDetailTypes'
import type { PhiPluginCatalogAction, PhiPluginCatalogEntry } from '../lib/phiPluginCatalog'
import { phiPluginDisplayTitle } from '../lib/phiPlugins'
import { pluginCopy } from '../lib/pluginCopy'
import {
  usePhiPluginCatalogDetail,
  type PhiPluginCatalogDetailState
} from '../hooks/usePhiPluginCatalogDetail'
import {
  PhiPluginComponentSections,
  type PhiPluginComponentSectionItem
} from './PhiPluginComponentSections'
import { PhiPluginEnvironmentSummary } from './PhiPluginEnvironmentSummary'

function catalogComponents(detail: PhiPluginCatalogDetail): PhiPluginComponentSectionItem[] {
  return [
    ...detail.agents.map((agent, index) => ({
      key: `agent:${agent.name}:${index}`,
      kind: 'agent' as const,
      name: agent.name,
      description: agent.description
    })),
    ...detail.skills.map((skill, index) => ({
      key: `skill:${skill.name}:${index}`,
      kind: 'skill' as const,
      name: skill.name,
      description: skill.description
    })),
    ...detail.scriptTools.map((tool, index) => ({
      key: `script:${tool.name}:${index}`,
      kind: 'script' as const,
      name: tool.name,
      description: tool.description,
      approval: tool.approval,
      skillName: tool.skillName
    }))
  ]
}

export function PhiPluginCatalogDetailSections({
  detail
}: {
  detail: PhiPluginCatalogDetail
}): React.JSX.Element {
  useUiLanguage()

  return (
    <Stack spacing={2.5} data-phi-plugin-catalog-sections="available">
      <PhiPluginComponentSections components={catalogComponents(detail)} />
      <Divider />
      <Box
        component="section"
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: '160px minmax(0, 1fr)' },
          columnGap: 2,
          rowGap: 0.75,
          alignItems: 'start'
        }}
      >
        <Typography variant="overline" color="text.secondary" sx={{ lineHeight: '24px' }}>
          {pluginCopy.environments}
        </Typography>
        {detail.environments.length > 0 ? (
          <Stack spacing={1}>
            {detail.environments.map((environment, index) => (
              <Box
                key={`${environment.id}:${index}`}
                data-phi-plugin-environment={environment.id}
                sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1.5 }}
              >
                <PhiPluginEnvironmentSummary
                  title={environment.title}
                  id={environment.id}
                  description={environment.description}
                  sharedNote={environment.sharedNote}
                  channels={environment.channels}
                  usedBySkills={environment.usedBySkills}
                  usedByAgents={environment.usedByAgents}
                  dependencyManifest={environment.dependencyManifest}
                />
              </Box>
            ))}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {pluginCopy.noManagedEnvironment}
          </Typography>
        )}
      </Box>
    </Stack>
  )
}

export function PhiPluginCatalogUnavailableSections({
  reason,
  onRetry
}: {
  reason: PhiPluginCatalogDetailReason
  onRetry: () => void
}): React.JSX.Element {
  useUiLanguage()

  if (reason === 'failed') {
    return (
      <Stack
        spacing={1.5}
        sx={{ alignItems: 'flex-start' }}
        data-phi-plugin-catalog-sections="failed"
      >
        <Typography variant="body2" color="text.secondary">
          {pluginCopy.catalogDetailFailed}
        </Typography>
        <Button size="small" variant="outlined" onClick={onRetry}>
          {pluginCopy.retry}
        </Button>
      </Stack>
    )
  }

  return (
    <>
      <Stack spacing={1}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {pluginCopy.components}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {pluginCopy.componentsAfterInstall}
        </Typography>
      </Stack>
      <Divider />
      <Stack spacing={1}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {pluginCopy.environments}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {pluginCopy.environmentsAfterInstall}
        </Typography>
      </Stack>
    </>
  )
}

function CatalogDetailLoading(): React.JSX.Element {
  useUiLanguage()
  return (
    <Stack role="status" aria-label={pluginCopy.loadingCatalogDetail} spacing={1.25}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">
          {pluginCopy.loadingCatalogDetail}
        </Typography>
      </Stack>
      <Skeleton variant="rounded" height={64} />
      <Skeleton variant="rounded" height={92} />
    </Stack>
  )
}

export function PhiPluginCatalogPreview({
  entry,
  action,
  installBusy,
  onInstall
}: {
  entry: PhiPluginCatalogEntry
  action: PhiPluginCatalogAction
  installBusy: boolean
  onInstall?: () => void
}): React.JSX.Element {
  useUiLanguage()

  const currentState = usePhiPluginCatalogDetail(entry.id)
  const detail = currentState.status === 'available' ? currentState.detail : null
  const title = detail?.title || phiPluginDisplayTitle(entry)

  return (
    <>
      <CatalogPreviewHeader
        entry={entry}
        detail={detail}
        title={title}
        action={action}
        installBusy={installBusy}
        onInstall={onInstall}
      />
      <Divider />
      <CatalogDetailBody state={currentState} />
    </>
  )
}

function CatalogDetailBody({ state }: { state: PhiPluginCatalogDetailState }): React.JSX.Element {
  if (state.status === 'loading') return <CatalogDetailLoading />
  if (state.status === 'available') return <PhiPluginCatalogDetailSections detail={state.detail} />
  return <PhiPluginCatalogUnavailableSections reason={state.reason} onRetry={state.retry} />
}

function CatalogPreviewMetadata({
  entry,
  detail,
  title,
  action
}: {
  entry: PhiPluginCatalogEntry
  detail: PhiPluginCatalogDetail | null
  title: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h4" sx={{ fontWeight: 750 }}>
            {title}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 0.25, fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}
          >
            {entry.id} · v{detail?.version || entry.version}
          </Typography>
        </Box>
        {action}
      </Stack>
      {/* The summary uses the full width under the title row, inset slightly from the divider. */}
      <Typography variant="body1" color="text.secondary" sx={{ mt: 1.25, pr: 2 }}>
        {detail?.summary || entry.summary}
      </Typography>
    </Box>
  )
}

function CatalogPreviewAction({
  title,
  action,
  installBusy,
  onInstall
}: {
  title: string
  action: PhiPluginCatalogAction
  installBusy: boolean
  onInstall?: () => void
}): React.JSX.Element {
  useUiLanguage()

  const label = action === 'update' ? pluginCopy.updateNamed(title) : pluginCopy.installNamed(title)
  if (installBusy) {
    return (
      <Box
        role="status"
        aria-label={pluginCopy.processing}
        sx={{ width: 34, height: 34, display: 'grid', placeItems: 'center', flexShrink: 0 }}
      >
        <CircularProgress size={18} />
      </Box>
    )
  }
  return (
    <IconButton
      aria-label={label}
      title={label}
      size="small"
      disabled={!onInstall}
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
      {action === 'update' ? (
        <GoSync size={18} aria-hidden="true" />
      ) : (
        <GoPlus size={18} aria-hidden="true" />
      )}
    </IconButton>
  )
}

function CatalogPreviewHeader({
  entry,
  detail,
  title,
  action,
  installBusy,
  onInstall
}: {
  entry: PhiPluginCatalogEntry
  detail: PhiPluginCatalogDetail | null
  title: string
  action: PhiPluginCatalogAction
  installBusy: boolean
  onInstall?: () => void
}): React.JSX.Element {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
      <Box
        sx={{
          width: 58,
          height: 58,
          flexShrink: 0,
          borderRadius: 2,
          display: 'grid',
          placeItems: 'center',
          color: 'primary.main',
          bgcolor: (theme) =>
            alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.09)
        }}
      >
        <ResourceIcon icon={entry.icon} kind="plugin" size={58} fallbackSize={30} />
      </Box>
      <CatalogPreviewMetadata
        entry={entry}
        detail={detail}
        title={title}
        action={
          <CatalogPreviewAction
            title={title}
            action={action}
            installBusy={installBusy}
            onInstall={onInstall}
          />
        }
      />
    </Stack>
  )
}
