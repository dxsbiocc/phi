import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Typography
} from '@mui/material'
import { GoPlus, GoSync } from 'react-icons/go'
import type {
  SearxngEngineOption,
  WebSearchKeyStatus,
  WebSearchSettings,
  WebSearchSettingsPatch
} from '../../../../shared/webSearchSettingsTypes'
import { SearxngEnginePicker } from './components/SearxngEnginePicker'
import { SearxngInstanceDialog } from './components/SearxngInstanceDialog'
import { SearchProviderList } from './components/SearchProviderList'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function WebSearchSettingsEditor({
  settings,
  onSave,
  onDirty,
  onRefresh,
  searxngCatalog,
  onSetApiKey,
  onClearApiKey,
  onOpenProviderSettings
}: {
  settings: WebSearchSettings
  onSave: (patch: WebSearchSettingsPatch) => Promise<void>
  onDirty?: () => void
  onRefresh?: () => void
  searxngCatalog?: SearxngEngineOption[]
  onSetApiKey?: (id: string, key: string) => Promise<WebSearchKeyStatus>
  onClearApiKey?: (id: string) => Promise<WebSearchKeyStatus>
  onOpenProviderSettings?: () => void
}): React.JSX.Element {
  const [enabledIds, setEnabledIds] = useState(settings.orderedEnabledIds)
  const [engines, setEngines] = useState(settings.searxngEngines)
  const [instanceDialogOpen, setInstanceDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const defaultIds = settings.providers.map((provider) => provider.id)
  const hasChanges =
    enabledIds.join('\0') !== settings.orderedEnabledIds.join('\0') ||
    engines !== settings.searxngEngines

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
        searxngEndpoint: settings.searxngEndpoint,
        searxngEngines: engines
      })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  async function saveInstance(nextEndpoint: string): Promise<void> {
    setSaving(true)
    try {
      await onSave({
        orderedEnabledIds: enabledIds,
        searxngEndpoint: nextEndpoint,
        searxngEngines: nextEndpoint ? engines : ''
      })
      setInstanceDialogOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Typography variant="h6">网页搜索</Typography>
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
          {onRefresh && (
            <IconButton aria-label="刷新网页搜索设置" size="small" onClick={onRefresh}>
              <GoSync size={17} />
            </IconButton>
          )}
          <Button
            size="small"
            disabled={saving || enabledIds.join('\0') === defaultIds.join('\0')}
            onClick={() => {
              onDirty?.()
              setEnabledIds(defaultIds)
            }}
          >
            重置服务
          </Button>
          <Button
            variant="contained"
            size="small"
            disabled={saving || !hasChanges}
            onClick={() => void save()}
          >
            {saving ? '保存中' : '保存'}
          </Button>
        </Stack>
      </Stack>

      <Stack spacing={1}>
        <Stack
          direction="row"
          sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              SearXNG
            </Typography>
            <Chip
              size="small"
              label={settings.searxngEndpoint ? '已连接' : '未连接'}
              color={settings.searxngEndpoint ? 'success' : 'default'}
            />
            {!enabledIds.includes('searxng') && (
              <Button size="small" onClick={() => toggleProvider('searxng')}>
                启用来源
              </Button>
            )}
          </Stack>
          <Stack direction="row" spacing={0.5}>
            {engines && (
              <Button
                size="small"
                disabled={saving}
                onClick={() => {
                  onDirty?.()
                  setEngines('')
                }}
              >
                使用默认
              </Button>
            )}
            <Button
              size="small"
              variant="contained"
              startIcon={settings.searxngEndpoint ? undefined : <GoPlus size={16} />}
              disabled={saving}
              onClick={() => setInstanceDialogOpen(true)}
            >
              {settings.searxngEndpoint ? '修改实例' : '添加实例'}
            </Button>
          </Stack>
        </Stack>
        <SearxngEnginePicker
          endpoint={settings.searxngEndpoint}
          engines={engines}
          onChange={(value) => {
            onDirty?.()
            setEngines(value)
          }}
          disabled={saving}
          catalog={searxngCatalog}
        />
      </Stack>

      <Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.75 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            搜索服务
          </Typography>
          <Chip size="small" label={`${enabledIds.length}/${settings.providers.length} 已启用`} />
        </Stack>
        <SearchProviderList
          providers={settings.providers}
          enabledIds={enabledIds}
          disabled={saving}
          onToggle={toggleProvider}
          onMove={moveProvider}
          onPrioritize={prioritizeProvider}
          onSetApiKey={onSetApiKey}
          onClearApiKey={onClearApiKey}
          onOpenProviderSettings={onOpenProviderSettings}
        />
      </Box>

      {instanceDialogOpen && (
        <SearxngInstanceDialog
          initialEndpoint={settings.searxngEndpoint}
          onClose={() => setInstanceDialogOpen(false)}
          onSave={saveInstance}
        />
      )}

      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  )
}

export function WebSearchSettingsPanel({
  onOpenProviderSettings
}: {
  onOpenProviderSettings?: () => void
}): React.JSX.Element {
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
      {saved && <Alert severity="success">搜索设置已保存，将用于后续搜索。</Alert>}
      {error && <Alert severity="error">刷新失败：{error}</Alert>}
      <WebSearchSettingsEditor
        key={revision}
        settings={settings}
        onSave={save}
        onDirty={() => setSaved(false)}
        onRefresh={() => void load()}
        onSetApiKey={window.api.setWebSearchApiKey}
        onClearApiKey={window.api.clearWebSearchApiKey}
        onOpenProviderSettings={onOpenProviderSettings}
      />
    </Stack>
  )
}
