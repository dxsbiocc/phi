import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { GoArrowLeft } from 'react-icons/go'

import type {
  EnvironmentToolId,
  ManagedEnvironmentEntry
} from '../../../../../shared/environmentTypes'
import {
  formatEnvironmentSize,
  type ManagedEnvironmentHostResources,
  managedEnvironmentSourceLabel,
  managedEnvironmentStateLabel
} from '../lib/environmentPanel'
import { EnvironmentBrandIcon, EnvironmentCapabilityChips } from './EnvironmentBrandIcon'
import { EnvironmentPackageList } from './EnvironmentPackageList'
import { HostDependenciesList } from './HostDependenciesSection'
import { HostToolsList } from './HostToolsSection'

type ManagedEnvironmentDetailProps = {
  environment: ManagedEnvironmentEntry
  busy: boolean
  error: string | null
  hostResources: ManagedEnvironmentHostResources
  hostBusy: boolean
  onBack: () => void
  onBuild: () => void
  onRebuild: () => void
  onRemove: () => void
  onSaveHostPath: (toolId: EnvironmentToolId, path: string | null) => Promise<void>
}

function title(environment: ManagedEnvironmentEntry): string {
  return environment.label?.trim() || environment.ref
}

export function ManagedEnvironmentDetail({
  environment,
  busy,
  error,
  hostResources,
  hostBusy,
  onBack,
  onBuild,
  onRebuild,
  onRemove,
  onSaveHostPath
}: ManagedEnvironmentDetailProps): React.JSX.Element {
  const canBuild = environment.source !== 'orphaned' && environment.state === 'absent'
  const canRebuild =
    environment.source !== 'orphaned' &&
    (environment.state === 'ready' ||
      environment.state === 'failed' ||
      environment.state === 'drifted')
  const removable =
    environment.referrers.length === 0 &&
    (environment.state === 'ready' ||
      environment.state === 'failed' ||
      environment.state === 'drifted')
  const hasHostResources = hostResources.tools.length + hostResources.dependencies.length > 0
  const hostTool = hostResources.tools[0]
  const localSelected = hostTool?.selected === true
  const managedSelected = !localSelected
  const localPath = hostTool?.path ?? hostTool?.detectedPath
  const showPackages = /^phi:(python|r)@/u.test(environment.ref)
  const [switchingMode, setSwitchingMode] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)

  const selectManaged = async (checked: boolean): Promise<void> => {
    if (!hostTool) return
    const nextPath = checked ? null : localPath
    if (!checked && !nextPath) return
    setSwitchingMode(true)
    setModeError(null)
    try {
      await onSaveHostPath(hostTool.id, nextPath ?? null)
    } catch (cause) {
      setModeError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSwitchingMode(false)
    }
  }

  return (
    <Stack spacing={2.5} data-phi-managed-environment-detail={environment.ref}>
      <Box>
        <Button autoFocus startIcon={<GoArrowLeft />} onClick={onBack} sx={{ minHeight: 44 }}>
          返回环境列表
        </Button>
      </Box>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: 'center' }}>
        <EnvironmentBrandIcon environment={environment} size={64} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ alignItems: 'center', flexWrap: 'wrap' }}
          >
            <Typography variant="h5" sx={{ fontWeight: 750 }}>
              {title(environment)}
            </Typography>
            <Chip
              size="small"
              variant="outlined"
              label={managedEnvironmentStateLabel(environment.state)}
            />
          </Stack>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 0.5, fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}
          >
            {environment.ref}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {managedEnvironmentSourceLabel(environment.source)}
            {environment.sizeBytes === undefined
              ? ''
              : ` · 占用 ${formatEnvironmentSize(environment.sizeBytes)}`}
          </Typography>
        </Box>
      </Stack>

      {environment.description ? <Typography>{environment.description}</Typography> : null}
      <EnvironmentCapabilityChips environment={environment} />
      {error || environment.error ? (
        <Alert severity="error">{error ?? environment.error}</Alert>
      ) : null}

      {hasHostResources ? (
        <>
          <Divider />
          <Box component="section" aria-labelledby="managed-environment-host-title">
            <Typography id="managed-environment-host-title" variant="h6" sx={{ fontWeight: 700 }}>
              本机环境
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
              Phi 会自动检测本机已有的工具与容器运行时；只有明确启用的非托管工具才会替代托管版本。
            </Typography>
            <Stack spacing={1}>
              {hostResources.tools.length ? (
                <HostToolsList
                  tools={hostResources.tools}
                  busy={hostBusy}
                  onSavePath={onSaveHostPath}
                />
              ) : null}
              {hostResources.dependencies.length ? (
                <HostDependenciesList dependencies={hostResources.dependencies} />
              ) : null}
            </Stack>
          </Box>
        </>
      ) : null}

      <Divider />

      <Paper
        component="section"
        variant="outlined"
        data-phi-environment-choice="managed"
        data-phi-environment-choice-selected={String(managedSelected)}
        sx={{ p: 1.5, borderRadius: 2, borderColor: managedSelected ? 'success.main' : 'divider' }}
      >
        <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack
              direction="row"
              spacing={0.75}
              useFlexGap
              sx={{ alignItems: 'center', flexWrap: 'wrap' }}
            >
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                Phi 托管环境
              </Typography>
              <Chip
                size="small"
                color={managedSelected ? 'success' : 'default'}
                variant="outlined"
                label={managedSelected ? '已启用' : '未启用'}
              />
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Phi 按锁文件构建和维护此环境。
            </Typography>
          </Box>
          <Switch
            checked={managedSelected}
            disabled={hostBusy || switchingMode || !hostTool || (managedSelected && !localPath)}
            onChange={(_, checked) => void selectManaged(checked)}
            slotProps={{ input: { 'aria-label': '启用 Phi 托管环境' } }}
          />
        </Stack>

        {modeError ? (
          <Alert severity="error" variant="outlined" sx={{ mt: 1.5 }}>
            {modeError}
          </Alert>
        ) : null}

        <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1.5, flexWrap: 'wrap' }}>
          {canBuild ? (
            <Button variant="contained" disabled={busy || !managedSelected} onClick={onBuild}>
              查看估算并构建
            </Button>
          ) : null}
          {canRebuild ? (
            <Button variant="outlined" disabled={busy || !managedSelected} onClick={onRebuild}>
              重新构建
            </Button>
          ) : null}
          {removable ? (
            <Button
              variant="outlined"
              color="error"
              disabled={busy || !managedSelected}
              onClick={onRemove}
            >
              移除托管环境
            </Button>
          ) : null}
        </Stack>
        {showPackages ? <EnvironmentPackageList packages={environment.packages ?? []} /> : null}
      </Paper>
    </Stack>
  )
}
