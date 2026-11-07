import { useUiLanguage } from '../../../lib/i18n'
import { Box, Chip, Stack, Typography } from '@mui/material'

import type {
  PhiPluginDependency,
  PhiPluginDependencyManifest
} from '../../../../../shared/phiPluginDetailTypes'
import { pluginCopy } from '../lib/pluginCopy'

type PhiPluginDependencyState = 'packages' | 'shared-runtime' | 'empty-manifest' | 'missing'

function phiPluginDependencyState(
  environmentId: string,
  manifest: PhiPluginDependencyManifest
): PhiPluginDependencyState {
  if (manifest.dependencies.length > 0) return 'packages'
  if (manifest.sourceFile) return 'empty-manifest'
  if (environmentId.startsWith('phi:')) return 'shared-runtime'
  return 'missing'
}

function dependencyLine(dependency: PhiPluginDependency): string {
  if (!dependency.version) return `- ${dependency.name}`
  return dependency.kind === 'source'
    ? `- ${dependency.name}@${dependency.version}`
    : `- ${dependency.name}=${dependency.version}`
}

function LookedForPaths({ paths }: { paths: readonly string[] }): React.JSX.Element | null {
  useUiLanguage()

  if (paths.length === 0) return null
  return (
    <Box component="details" sx={{ mt: 1.25 }}>
      <Typography
        component="summary"
        variant="caption"
        color="text.secondary"
        sx={{ cursor: 'pointer', width: 'fit-content' }}
      >
        {pluginCopy.lookedForPaths}
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ mt: 0.75, display: 'block', lineHeight: 1.6 }}
      >
        {pluginCopy.lookedForPathsDescription}
      </Typography>
      <Typography
        component="div"
        variant="caption"
        color="text.secondary"
        sx={{
          mt: 0.5,
          fontFamily: 'var(--font-mono)',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.55,
          overflowWrap: 'anywhere'
        }}
      >
        {paths.join('\n')}
      </Typography>
    </Box>
  )
}

export function PhiPluginDependencySummary({
  environmentId,
  manifest
}: {
  environmentId: string
  manifest: PhiPluginDependencyManifest
}): React.JSX.Element {
  useUiLanguage()

  const state = phiPluginDependencyState(environmentId, manifest)
  return (
    <Box data-phi-plugin-dependency-state={state} sx={{ mt: 2 }}>
      <Typography sx={{ fontWeight: 650, fontSize: 13.5, mb: 1 }}>
        {pluginCopy.dependencies}
      </Typography>
      {state === 'packages' ? (
        <>
          {manifest.sourceFile ? (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mb: 1, fontFamily: 'var(--font-mono)' }}
            >
              {pluginCopy.dependencySource}: {manifest.sourceFile}
            </Typography>
          ) : null}
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1.5,
              maxHeight: 360,
              overflow: 'auto',
              borderRadius: 1.5,
              border: 1,
              borderColor: 'divider',
              bgcolor: 'action.hover',
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              lineHeight: 1.55,
              whiteSpace: 'pre',
              color: 'text.primary'
            }}
          >
            {manifest.yamlText ?? manifest.dependencies.map(dependencyLine).join('\n')}
          </Box>
        </>
      ) : (
        <Box
          sx={{
            p: 1.5,
            borderRadius: 1.5,
            bgcolor: 'action.hover',
            border: '1px dashed',
            borderColor: 'divider'
          }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.65 }}>
            {state === 'shared-runtime'
              ? pluginCopy.sharedRuntimeDependencies(environmentId)
              : state === 'empty-manifest'
                ? pluginCopy.emptyDependencyManifest(manifest.sourceFile ?? '')
                : pluginCopy.missingDependencyManifest}
          </Typography>
          {state === 'missing' ? <LookedForPaths paths={manifest.lookedFor} /> : null}
        </Box>
      )}
    </Box>
  )
}

function EnvironmentUsage({
  label,
  names
}: {
  label: string
  names: readonly string[]
}): React.JSX.Element | null {
  if (names.length === 0) return null
  return (
    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
      {label}: {names.join(', ')}
    </Typography>
  )
}

export function PhiPluginEnvironmentSummary({
  title,
  id,
  description,
  sharedNote,
  scopeLabel,
  channels,
  usedBySkills,
  usedByAgents,
  dependencyManifest
}: {
  title: string
  id: string
  description?: string
  sharedNote?: string
  scopeLabel?: string
  channels: readonly string[]
  usedBySkills: readonly string[]
  usedByAgents: readonly string[]
  dependencyManifest: PhiPluginDependencyManifest
}): React.JSX.Element {
  useUiLanguage()

  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Typography sx={{ fontWeight: 650 }}>{title}</Typography>
        {scopeLabel ? <Chip size="small" variant="outlined" label={scopeLabel} /> : null}
        {sharedNote ? <Chip size="small" variant="outlined" label={sharedNote} /> : null}
      </Stack>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}
      >
        {id}
      </Typography>
      {description ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {description}
        </Typography>
      ) : null}
      {channels.length > 0 ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          {pluginCopy.channels}: {channels.join(', ')}
        </Typography>
      ) : null}
      <EnvironmentUsage label={pluginCopy.usedBySkills} names={usedBySkills} />
      <EnvironmentUsage label={pluginCopy.usedByAgents} names={usedByAgents} />
      <PhiPluginDependencySummary environmentId={id} manifest={dependencyManifest} />
    </Box>
  )
}
