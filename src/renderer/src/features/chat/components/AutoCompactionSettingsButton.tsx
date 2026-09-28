import {
  Box,
  Button,
  CircularProgress,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Popover,
  Select,
  Switch,
  Tooltip,
  Typography
} from '@mui/material'
import { useEffect, useId, useState } from 'react'
import type {
  AutoCompactionSettingsPatch,
  CurrentAutoCompactionSettings,
  ManualCompactionTarget
} from '../../../../../shared/contextUsageTypes'
import { getRendererApi } from '../../../lib/rendererApi'
import { PhiIcons } from '../../../icons'

const SettingsIcon = PhiIcons.nav.settings

export function AutoCompactionSettingsButton({
  target,
  disabled = false
}: {
  target: ManualCompactionTarget
  disabled?: boolean
}): React.JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [settingsState, setSettingsState] = useState<{
    key: string
    value: CurrentAutoCompactionSettings
  } | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [errorState, setErrorState] = useState<{ key: string; message: string } | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const thresholdLabelId = useId()
  const { sessionPath, phiSessionId, sessionGeneration } = target
  const targetKey = JSON.stringify([sessionPath, phiSessionId, sessionGeneration])
  const open = Boolean(anchor)
  const settings = settingsState?.key === targetKey ? settingsState.value : null
  const error = errorState?.key === targetKey ? errorState.message : null
  const loading = !settings && !error
  const saving = savingKey === targetKey

  useEffect(() => {
    if (!open || !sessionPath) return undefined
    let cancelled = false
    void getRendererApi()
      .getAutoCompactionSettings({ sessionPath, phiSessionId, sessionGeneration })
      .then((result) => {
        if (!cancelled) {
          setSettingsState({ key: targetKey, value: result })
          setErrorState((current) => (current?.key === targetKey ? null : current))
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setErrorState({
            key: targetKey,
            message: failure instanceof Error ? failure.message : String(failure)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, targetKey, sessionPath, phiSessionId, sessionGeneration, retryKey])

  const save = async (patch: AutoCompactionSettingsPatch): Promise<void> => {
    setSavingKey(targetKey)
    setErrorState(null)
    try {
      const next = await getRendererApi().setAutoCompactionSettings(target, patch)
      setSettingsState((current) =>
        current?.key === targetKey ? { key: targetKey, value: next } : current
      )
    } catch (failure) {
      setErrorState({
        key: targetKey,
        message: failure instanceof Error ? failure.message : String(failure)
      })
    } finally {
      setSavingKey((current) => (current === targetKey ? null : current))
    }
  }

  const controlsDisabled = disabled || loading || saving || !settings
  const selectedThreshold = settings?.overrides.thresholdPercent ?? 'default'
  const defaultThreshold = settings?.defaults.thresholdPercent
  const defaultTokenThreshold = settings?.defaults.thresholdTokens
  const hasOverrides =
    settings?.overrides.enabled !== undefined || settings?.overrides.thresholdPercent !== undefined

  return (
    <>
      <Tooltip title="自动压缩设置">
        <span>
          <IconButton
            size="small"
            aria-label="自动压缩设置"
            disabled={disabled || !target.sessionPath}
            onClick={(event) => {
              setErrorState(null)
              setAnchor(event.currentTarget)
            }}
            sx={{ p: 0.5 }}
          >
            <SettingsIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Popover
        open={open}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Box sx={{ width: 280, maxWidth: 'calc(100vw - 32px)', p: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 1.25 }}>
            自动压缩
          </Typography>
          {loading && <CircularProgress size={18} aria-label="正在读取自动压缩设置" />}
          {settings && (
            <>
              <FormControlLabel
                control={
                  <Switch
                    checked={settings.enabled}
                    disabled={controlsDisabled}
                    onChange={(_, checked) => void save({ enabled: checked })}
                    slotProps={{ input: { 'aria-label': '当前会话自动压缩' } }}
                  />
                }
                label="启用自动压缩"
                sx={{ ml: 0, mb: 1 }}
              />
              <FormControl fullWidth size="small" disabled={controlsDisabled || !settings.enabled}>
                <InputLabel id={thresholdLabelId}>触发阈值</InputLabel>
                <Select
                  labelId={thresholdLabelId}
                  label="触发阈值"
                  value={selectedThreshold}
                  onChange={(event) => {
                    if (event.target.value === 'default') {
                      void save({ thresholdPercent: null })
                      return
                    }
                    const value = Number(event.target.value)
                    if (value === 70 || value === 80 || value === 90) {
                      void save({ thresholdPercent: value })
                    }
                  }}
                >
                  <MenuItem value="default">
                    SDK 默认
                    {defaultTokenThreshold && defaultTokenThreshold > 0
                      ? `（${defaultTokenThreshold.toLocaleString('zh-CN')} tokens）`
                      : defaultThreshold && defaultThreshold > 0
                        ? `（${defaultThreshold}%）`
                        : ''}
                  </MenuItem>
                  <MenuItem value={70}>70% · 提前</MenuItem>
                  <MenuItem value={80}>80% · 适中</MenuItem>
                  <MenuItem value={90}>90% · 较晚</MenuItem>
                </Select>
              </FormControl>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                仅作用于当前会话
              </Typography>
              {hasOverrides && (
                <Button
                  size="small"
                  disabled={controlsDisabled}
                  onClick={() => void save({ enabled: null, thresholdPercent: null })}
                  sx={{ mt: 1, px: 0 }}
                >
                  恢复 SDK 默认
                </Button>
              )}
            </>
          )}
          {error && (
            <>
              <Typography
                role="alert"
                variant="caption"
                color="error"
                sx={{ display: 'block', mt: 1 }}
              >
                {error}
              </Typography>
              {!settings && (
                <Button
                  size="small"
                  onClick={() => {
                    setErrorState(null)
                    setRetryKey((value) => value + 1)
                  }}
                >
                  重试
                </Button>
              )}
            </>
          )}
        </Box>
      </Popover>
    </>
  )
}
