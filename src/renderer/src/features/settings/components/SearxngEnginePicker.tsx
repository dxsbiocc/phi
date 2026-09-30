import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import type { SearxngEngineOption } from '../../../../../shared/webSearchSettingsTypes'
import { filterSearxngEngines } from '../lib/searxngEngines'

function engineNames(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

export function SearxngEnginePicker({
  endpoint,
  savedEndpoint,
  engines,
  onChange,
  disabled = false,
  catalog
}: {
  endpoint: string
  savedEndpoint: string
  engines: string
  onChange: (value: string) => void
  disabled?: boolean
  catalog?: SearxngEngineOption[]
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<SearxngEngineOption[] | null>(catalog ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const selected = engineNames(engines)
  const enabledNames = loaded?.filter((engine) => engine.enabled).map((engine) => engine.name) ?? []
  const effectiveSelected = selected.length ? selected : enabledNames
  const unknownNames = selected.filter((name) => !loaded?.some((engine) => engine.name === name))
  const endpointChanged = endpoint.trim().replace(/\/+$/, '') !== savedEndpoint.replace(/\/+$/, '')
  const visibleEngines = loaded ? filterSearxngEngines(loaded, filter) : []

  async function refresh(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      setLoaded(await window.api.listSearxngEngines())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (catalog || !savedEndpoint) return
    let active = true
    void window.api
      .listSearxngEngines()
      .then((result) => {
        if (active) setLoaded(result)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
    }
  }, [catalog, savedEndpoint])

  function toggle(name: string): void {
    const next = effectiveSelected.includes(name)
      ? effectiveSelected.filter((item) => item !== name)
      : [...effectiveSelected, name]
    if (!next.length) return
    const matchesDefault =
      next.length === enabledNames.length && enabledNames.every((item) => next.includes(item))
    onChange(matchesDefault ? '' : next.join(','))
  }

  return (
    <Stack spacing={1.25}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="subtitle2">SearXNG 搜索引擎</Typography>
          <Typography variant="caption" color="text.secondary">
            {selected.length ? `限定使用 ${selected.length} 个引擎` : '使用实例默认启用的引擎'}
          </Typography>
        </Box>
        <Button
          size="small"
          disabled={disabled || loading || !savedEndpoint || endpointChanged || Boolean(catalog)}
          onClick={() => void refresh()}
        >
          {loading ? '读取中' : '刷新引擎'}
        </Button>
      </Stack>

      {!savedEndpoint && (
        <Typography variant="body2" color="text.secondary">
          保存实例地址后，即可读取该实例提供的搜索引擎。
        </Typography>
      )}
      {endpointChanged && savedEndpoint && (
        <Typography variant="body2" color="text.secondary">
          地址已更改；保存后再刷新引擎列表。
        </Typography>
      )}
      {loading && <CircularProgress size={18} />}
      {error && <Alert severity="warning">读取引擎失败：{error}。仍可手动填写名称。</Alert>}
      {loaded && (
        <TextField
          fullWidth
          size="small"
          label="查找实例引擎"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          helperText={`当前实例列出 ${loaded.length} 个引擎`}
        />
      )}
      {loaded && (
        <Paper variant="outlined" sx={{ maxHeight: 205, overflowY: 'auto', borderRadius: 1 }}>
          {visibleEngines.map((engine) => {
            const checked = effectiveSelected.includes(engine.name)
            return (
              <Box
                key={engine.name}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 1,
                  minHeight: 44,
                  borderBottom: 1,
                  borderColor: 'divider',
                  '&:last-child': { borderBottom: 0 }
                }}
              >
                <Checkbox
                  size="small"
                  checked={checked}
                  disabled={
                    disabled || endpointChanged || (checked && effectiveSelected.length === 1)
                  }
                  onChange={() => toggle(engine.name)}
                  slotProps={{ input: { 'aria-label': `选择 ${engine.name} 引擎` } }}
                />
                <Typography variant="body2" sx={{ minWidth: 0, flex: 1 }}>
                  {engine.name}
                </Typography>
                {engine.shortcut && (
                  <Chip size="small" variant="outlined" label={engine.shortcut} />
                )}
                {!engine.enabled && (
                  <Typography variant="caption" color="text.secondary">
                    默认关闭
                  </Typography>
                )}
                <Button
                  size="small"
                  disabled={disabled || endpointChanged || engines === engine.name}
                  onClick={() => onChange(engine.name)}
                >
                  仅此
                </Button>
              </Box>
            )
          })}
          {visibleEngines.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
              {filter ? '没有匹配的引擎。' : '实例未列出搜索引擎。'}
            </Typography>
          )}
        </Paper>
      )}

      {loaded && unknownNames.length > 0 && (
        <Alert severity="warning">实例未列出已填写的引擎：{unknownNames.join('、')}</Alert>
      )}

      <TextField
        fullWidth
        size="small"
        label="限定引擎名称（可选）"
        value={engines}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        helperText="留空使用实例默认；多个名称用逗号分隔。标为“默认关闭”的引擎也可显式选择。"
      />
    </Stack>
  )
}
