import {
  Box,
  Button,
  CircularProgress,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  Typography
} from '@mui/material'
import { useEffect, useId, useState } from 'react'
import type {
  AutoCompactionSettingsPatch,
  CurrentAutoCompactionSettings,
  ManualCompactionTarget
} from '../../../../../shared/contextUsageTypes'
import { getRendererApi } from '../../../lib/rendererApi'

export function AutoCompactionSettingsSection({
  target,
  disabled = false,
  compacting = false,
  compactDisabled = false,
  onCompact
}: {
  target: ManualCompactionTarget | null
  disabled?: boolean
  compacting?: boolean
  compactDisabled?: boolean
  onCompact?: () => void
}): React.JSX.Element {
  const [settingsState, setSettingsState] = useState<{
    key: string
    value: CurrentAutoCompactionSettings
  } | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [errorState, setErrorState] = useState<{ key: string; message: string } | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const thresholdLabelId = useId()
  const sessionPath = target?.sessionPath ?? null
  const phiSessionId = target?.phiSessionId ?? null
  const sessionGeneration = target?.sessionGeneration ?? 0
  const targetKey = JSON.stringify([sessionPath, phiSessionId, sessionGeneration])
  const settings = settingsState?.key === targetKey ? settingsState.value : null
  const error = errorState?.key === targetKey ? errorState.message : null
  const loading = Boolean(sessionPath) && !settings && !error
  const controlsDisabled = disabled || loading || savingKey === targetKey || !settings

  useEffect(() => {
    if (!sessionPath) return undefined
    let cancelled = false
    void getRendererApi()
      .getAutoCompactionSettings({ sessionPath, phiSessionId, sessionGeneration })
      .then((value) => {
        if (!cancelled) {
          setSettingsState({ key: targetKey, value })
          setErrorState((current) => (current?.key === targetKey ? null : current))
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled)
          setErrorState({
            key: targetKey,
            message: failure instanceof Error ? failure.message : String(failure)
          })
      })
    return () => {
      cancelled = true
    }
  }, [targetKey, sessionPath, phiSessionId, sessionGeneration, retryKey])

  const save = async (patch: AutoCompactionSettingsPatch): Promise<void> => {
    if (!target) return
    setSavingKey(targetKey)
    setErrorState(null)
    try {
      const value = await getRendererApi().setAutoCompactionSettings(target, patch)
      setSettingsState((current) =>
        current?.key === targetKey ? { key: targetKey, value } : current
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

  const hasOverrides =
    settings?.overrides.enabled !== undefined || settings?.overrides.thresholdPercent !== undefined
  const defaultTokenThreshold = settings?.defaults.thresholdTokens
  const defaultThreshold = settings?.defaults.thresholdPercent

  return (
    <Box>
      <Typography variant="body1" sx={{ fontWeight: 600 }}>
        上下文压缩
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        自动压缩设置仅作用于当前会话。
      </Typography>
      {!sessionPath && (
        <Typography variant="body2" color="text.secondary">
          打开会话后可调整压缩设置。
        </Typography>
      )}
      {loading && <CircularProgress size={18} aria-label="正在读取自动压缩设置" />}
      {settings && (
        <Box sx={{ maxWidth: 360 }}>
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
              value={settings.overrides.thresholdPercent ?? 'default'}
              onChange={(event) => {
                if (event.target.value === 'default') return void save({ thresholdPercent: null })
                const value = Number(event.target.value)
                if (value === 70 || value === 80 || value === 90)
                  void save({ thresholdPercent: value })
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
        </Box>
      )}
      {error && (
        <Box>
          <Typography role="alert" variant="caption" color="error">
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
        </Box>
      )}
      {onCompact && (
        <Button
          type="button"
          size="small"
          variant="outlined"
          aria-label="压缩当前会话上下文"
          disabled={!sessionPath || compactDisabled || compacting}
          onClick={onCompact}
          sx={{ mt: 1.5 }}
        >
          {compacting ? '正在压缩…' : '立即压缩当前会话'}
        </Button>
      )}
    </Box>
  )
}
