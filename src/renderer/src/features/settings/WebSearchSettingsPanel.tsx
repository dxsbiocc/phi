import { useEffect, useState } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import { GoChevronDown, GoChevronUp, GoSync } from 'react-icons/go'
import type {
  SearxngEngineOption,
  WebSearchSettings,
  WebSearchSettingsPatch
} from '../../../../shared/webSearchSettingsTypes'
import { SearxngEnginePicker } from './components/SearxngEnginePicker'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function WebSearchSettingsEditor({
  settings,
  onSave,
  onDirty,
  searxngCatalog
}: {
  settings: WebSearchSettings
  onSave: (patch: WebSearchSettingsPatch) => Promise<void>
  onDirty?: () => void
  searxngCatalog?: SearxngEngineOption[]
}): React.JSX.Element {
  const [enabledIds, setEnabledIds] = useState(settings.orderedEnabledIds)
  const [endpoint, setEndpoint] = useState(settings.searxngEndpoint)
  const [engines, setEngines] = useState(settings.searxngEngines)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const defaultIds = settings.providers.map((provider) => provider.id)
  const hasChanges =
    enabledIds.join('\0') !== settings.orderedEnabledIds.join('\0') ||
    endpoint !== settings.searxngEndpoint ||
    engines !== settings.searxngEngines
  const orderedProviders = [
    ...enabledIds.flatMap((id) => {
      const provider = settings.providers.find((item) => item.id === id)
      return provider ? [provider] : []
    }),
    ...settings.providers.filter((provider) => !enabledIds.includes(provider.id))
  ]

  function toggleProvider(id: string): void {
    onDirty?.()
    setError(null)
    setEnabledIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    )
  }

  function moveProvider(id: string, direction: -1 | 1): void {
    onDirty?.()
    setEnabledIds((current) => {
      const index = current.indexOf(id)
      const nextIndex = index + direction
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current
      const next = [...current]
      const selected = next[index]
      next[index] = next[nextIndex]
      next[nextIndex] = selected
      return next
    })
  }

  function prioritizeProvider(id: string): void {
    onDirty?.()
    setEnabledIds((current) => [id, ...current.filter((item) => item !== id)])
  }

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await onSave({
        orderedEnabledIds: enabledIds,
        searxngEndpoint: endpoint,
        searxngEngines: engines
      })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography variant="h6">网页搜索</Typography>
        <Typography variant="body2" color="text.secondary">
          配置 SearXNG 实例内的搜索引擎，以及网页搜索使用的上游服务。
        </Typography>
      </Box>

      <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
        <Stack spacing={1.5}>
          <Typography variant="subtitle2">SearXNG 实例</Typography>
          <TextField
            fullWidth
            size="small"
            label="实例地址"
            placeholder="http://127.0.0.1:8888"
            value={endpoint}
            disabled={saving}
            onChange={(event) => {
              onDirty?.()
              setEndpoint(event.target.value)
            }}
            helperText="填写根地址；实例须启用 JSON 搜索接口。"
          />
          <SearxngEnginePicker
            endpoint={endpoint}
            savedEndpoint={settings.searxngEndpoint}
            engines={engines}
            onChange={(value) => {
              onDirty?.()
              setEngines(value)
            }}
            disabled={saving}
            catalog={searxngCatalog}
          />
          {!enabledIds.includes('searxng') && (
            <Alert severity="info">
              SearXNG 服务提供方已关闭；如需使用，请在下方高级设置中启用。
            </Alert>
          )}
        </Stack>
      </Paper>

      <Accordion disableGutters variant="outlined" sx={{ borderRadius: 1 }}>
        <AccordionSummary expandIcon={<GoChevronDown size={18} />}>
          <Box>
            <Typography variant="subtitle2">上游搜索服务提供方（高级）</Typography>
            <Typography variant="caption" color="text.secondary">
              OMP 服务提供方与上方的 SearXNG 实例引擎分开管理。
            </Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails sx={{ p: 1.5, pt: 0 }}>
          <Paper variant="outlined" sx={{ borderRadius: 1, overflow: 'hidden' }}>
            <Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider' }}>
              <Typography variant="body2" color="text.secondary">
                已启用 {enabledIds.length} / {settings.providers.length} · 排在前面的服务优先使用
              </Typography>
            </Box>
            <Box sx={{ maxHeight: 260, overflowY: 'auto' }}>
              {orderedProviders.map((provider) => {
                const index = enabledIds.indexOf(provider.id)
                const enabled = index >= 0
                return (
                  <Box
                    key={provider.id}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      px: 1.5,
                      py: 0.5,
                      minHeight: 52,
                      borderBottom: 1,
                      borderColor: 'divider',
                      '&:last-child': { borderBottom: 0 }
                    }}
                  >
                    <Switch
                      checked={enabled}
                      disabled={saving || (enabled && enabledIds.length === 1)}
                      onChange={() => toggleProvider(provider.id)}
                      slotProps={{ input: { 'aria-label': `启用 ${provider.label} 搜索` } }}
                    />
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
                        {provider.label}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ fontFamily: 'var(--font-mono)' }}
                      >
                        {provider.id}
                      </Typography>
                    </Box>
                    {enabled && (
                      <Stack direction="row" spacing={0.25}>
                        {index > 0 && (
                          <Button
                            size="small"
                            disabled={saving}
                            onClick={() => prioritizeProvider(provider.id)}
                          >
                            置顶
                          </Button>
                        )}
                        <IconButton
                          size="small"
                          aria-label={`上移 ${provider.label}`}
                          disabled={saving || index === 0}
                          onClick={() => moveProvider(provider.id, -1)}
                        >
                          <GoChevronUp size={18} />
                        </IconButton>
                        <IconButton
                          size="small"
                          aria-label={`下移 ${provider.label}`}
                          disabled={saving || index === enabledIds.length - 1}
                          onClick={() => moveProvider(provider.id, 1)}
                        >
                          <GoChevronDown size={18} />
                        </IconButton>
                      </Stack>
                    )}
                  </Box>
                )
              })}
            </Box>
          </Paper>
        </AccordionDetails>
      </Accordion>

      {error && <Alert severity="error">{error}</Alert>}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="contained" disabled={saving || !hasChanges} onClick={() => void save()}>
          {saving ? '保存中' : '保存搜索设置'}
        </Button>
        <Button
          disabled={saving || enabledIds.join('\0') === defaultIds.join('\0')}
          onClick={() => {
            onDirty?.()
            setEnabledIds(defaultIds)
          }}
        >
          恢复默认提供方
        </Button>
      </Stack>
    </Stack>
  )
}

export function WebSearchSettingsPanel(): React.JSX.Element {
  const [settings, setSettings] = useState<WebSearchSettings | null>(null)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function load(): Promise<void> {
    setLoading(true)
    setError(null)
    setSaved(false)
    try {
      setSettings(await window.api.getWebSearchSettings())
      setRevision((current) => current + 1)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    void window.api
      .getWebSearchSettings()
      .then((result) => {
        if (active) setSettings(result)
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function save(patch: WebSearchSettingsPatch): Promise<void> {
    const next = await window.api.updateWebSearchSettings(patch)
    setSettings(next)
    setRevision((current) => current + 1)
    setSaved(true)
  }

  if (loading) {
    return (
      <Stack spacing={1} sx={{ py: 2 }}>
        <Typography variant="h6">网页搜索</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={18} />
          <Typography variant="body2" color="text.secondary">
            读取设置…
          </Typography>
        </Box>
      </Stack>
    )
  }

  if (!settings) {
    return (
      <Alert severity="error" action={<Button onClick={() => void load()}>重试</Button>}>
        {error ?? '无法读取网页搜索设置'}
      </Alert>
    )
  }

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
        <IconButton aria-label="刷新网页搜索设置" size="small" onClick={() => void load()}>
          <GoSync size={17} />
        </IconButton>
      </Stack>
      {saved && <Alert severity="success">搜索设置已保存，将用于后续搜索。</Alert>}
      {error && <Alert severity="error">刷新失败：{error}</Alert>}
      <WebSearchSettingsEditor
        key={revision}
        settings={settings}
        onSave={save}
        onDirty={() => setSaved(false)}
      />
    </Stack>
  )
}
