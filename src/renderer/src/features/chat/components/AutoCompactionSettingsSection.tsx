import { chatCopy } from '../lib/chatCopy'
import { getUiLocale, useUiLanguage } from '../../../lib/i18n'
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
import { useEffect, useId, useRef, useState } from 'react'
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
  useUiLanguage()
  const [settingsState, setSettingsState] = useState<{
    key: string
    value: CurrentAutoCompactionSettings
  } | null>(null)
  const [savingKeys, setSavingKeys] = useState<Set<string>>(() => new Set())
  const savingKeysRef = useRef(new Set<string>())
  const requestRef = useRef(0)
  const activeTargetKeyRef = useRef('')
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
  const controlsDisabled =
    disabled || compacting || loading || savingKeys.has(targetKey) || !settings

  useEffect(() => {
    activeTargetKeyRef.current = targetKey
    const request = ++requestRef.current
    if (!sessionPath) return undefined
    let cancelled = false
    void getRendererApi()
      .getAutoCompactionSettings({ sessionPath, phiSessionId, sessionGeneration })
      .then((value) => {
        if (!cancelled && request === requestRef.current) {
          setSettingsState({ key: targetKey, value })
          setErrorState((current) => (current?.key === targetKey ? null : current))
        }
      })
      .catch((failure: unknown) => {
        // Keep empty messages falsy because `loading` is derived from `!error`.
        if (!cancelled && request === requestRef.current)
          setErrorState({
            key: targetKey,
            message: failure instanceof Error ? failure.message : String(failure)
          })
      })
    return () => {
      cancelled = true
      requestRef.current += 1
      activeTargetKeyRef.current = ''
    }
  }, [targetKey, sessionPath, phiSessionId, sessionGeneration, retryKey])

  const save = async (patch: AutoCompactionSettingsPatch): Promise<void> => {
    if (
      !target ||
      controlsDisabled ||
      activeTargetKeyRef.current !== targetKey ||
      savingKeysRef.current.has(targetKey)
    )
      return
    const request = ++requestRef.current
    savingKeysRef.current.add(targetKey)
    setSavingKeys((current) => new Set(current).add(targetKey))
    setErrorState(null)
    try {
      const value = await getRendererApi().setAutoCompactionSettings(target, patch)
      if (request === requestRef.current && activeTargetKeyRef.current === targetKey) {
        setSettingsState({ key: targetKey, value })
      }
    } catch (failure) {
      if (request === requestRef.current && activeTargetKeyRef.current === targetKey) {
        // Keep empty messages falsy because `loading` is derived from `!error`.
        setErrorState({
          key: targetKey,
          message: failure instanceof Error ? failure.message : String(failure)
        })
      }
    } finally {
      savingKeysRef.current.delete(targetKey)
      setSavingKeys((current) => {
        const next = new Set(current)
        next.delete(targetKey)
        return next
      })
      // Returning to the same session needs a fresh read, not an old save receipt.
      if (activeTargetKeyRef.current === targetKey && request !== requestRef.current) {
        setRetryKey((current) => current + 1)
      }
    }
  }

  const hasOverrides =
    settings?.overrides.enabled !== undefined || settings?.overrides.thresholdPercent !== undefined
  const defaultTokenThreshold = settings?.defaults.thresholdTokens
  const defaultThreshold = settings?.defaults.thresholdPercent

  return (
    <Box>
      <Typography variant="body1" sx={{ fontWeight: 600 }}>
        {chatCopy.contextCompaction}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {chatCopy.autoCompactionSettingsApplyToThisConversationOnly}
      </Typography>
      {!sessionPath && (
        <Typography variant="body2" color="text.secondary">
          {chatCopy.openAConversationToAdjustCompactionSettings}
        </Typography>
      )}
      {loading && (
        <CircularProgress size={18} aria-label={chatCopy.loadingAutoCompactionSettings} />
      )}
      {settings && (
        <Box sx={{ maxWidth: 360 }}>
          <FormControlLabel
            control={
              <Switch
                checked={settings.enabled}
                disabled={controlsDisabled}
                onChange={(_, checked) => void save({ enabled: checked })}
                slotProps={{ input: { 'aria-label': chatCopy.autoCompactionForThisConversation } }}
              />
            }
            label={chatCopy.enableAutoCompaction}
            sx={{ ml: 0, mb: 1 }}
          />
          <FormControl fullWidth size="small" disabled={controlsDisabled || !settings.enabled}>
            <InputLabel id={thresholdLabelId}>{chatCopy.triggerThreshold}</InputLabel>
            <Select
              labelId={thresholdLabelId}
              label={chatCopy.triggerThreshold}
              value={settings.overrides.thresholdPercent ?? 'default'}
              onChange={(event) => {
                if (event.target.value === 'default') return void save({ thresholdPercent: null })
                const value = Number(event.target.value)
                if (value === 70 || value === 80 || value === 90)
                  void save({ thresholdPercent: value })
              }}
            >
              <MenuItem value="default">
                {chatCopy.sDKDefault}
                {defaultTokenThreshold && defaultTokenThreshold > 0
                  ? `(${defaultTokenThreshold.toLocaleString(getUiLocale())} tokens)`
                  : defaultThreshold && defaultThreshold > 0
                    ? `(${defaultThreshold}%)`
                    : ''}
              </MenuItem>
              <MenuItem value={70}>{chatCopy.label70Early}</MenuItem>
              <MenuItem value={80}>{chatCopy.label80Moderate}</MenuItem>
              <MenuItem value={90}>{chatCopy.label90Late}</MenuItem>
            </Select>
          </FormControl>
          {hasOverrides && (
            <Button
              size="small"
              disabled={controlsDisabled}
              onClick={() => void save({ enabled: null, thresholdPercent: null })}
              sx={{ mt: 1, px: 0 }}
            >
              {chatCopy.restoreSDKDefault}
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
              {chatCopy.retry}
            </Button>
          )}
        </Box>
      )}
      {onCompact && (
        <Button
          type="button"
          size="small"
          variant="outlined"
          aria-label={chatCopy.compactTheCurrentConversationContext}
          disabled={!sessionPath || compactDisabled || compacting}
          onClick={onCompact}
          sx={{ mt: 1.5 }}
        >
          {compacting ? chatCopy.compacting : chatCopy.compactThisConversationNow}
        </Button>
      )}
    </Box>
  )
}
