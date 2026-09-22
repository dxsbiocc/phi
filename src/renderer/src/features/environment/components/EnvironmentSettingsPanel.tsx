import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'

import { PhiIcons } from '../../../icons'
import type { EnvironmentSnapshot, EnvironmentToolId, EnvironmentToolState } from '../../../types'

const BrowseIcon = PhiIcons.entity.folder

function statusChip(tool: EnvironmentToolState): React.JSX.Element {
  if (tool.status === 'ready') {
    return <Chip size="small" color="success" variant="outlined" label="已就绪" />
  }
  if (tool.status === 'invalid') {
    return <Chip size="small" color="warning" variant="outlined" label="路径无效" />
  }
  return <Chip size="small" variant="outlined" label="未检测到" />
}

function sourceChip(tool: EnvironmentToolState): React.JSX.Element | null {
  if (tool.source === 'custom') {
    return <Chip size="small" variant="outlined" label="自定义" />
  }
  return null
}

async function pickEnvironmentBinary(): Promise<string | null> {
  const api = window.api as { pickEnvironmentBinary?: () => Promise<string | null> }
  if (typeof api.pickEnvironmentBinary !== 'function') {
    throw new Error('文件选择接口不可用，请完全退出并重新打开 Phi 后再试')
  }
  return api.pickEnvironmentBinary()
}

type ToolCardProps = {
  tool: EnvironmentToolState
  busy: boolean
  onSavePath: (toolId: EnvironmentToolId, path: string | null) => Promise<void>
}

function ToolCard({ tool, busy, onSavePath }: ToolCardProps): React.JSX.Element {
  const [draft, setDraft] = useState(tool.activePath ?? tool.detectedPath ?? '')
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = draft.trim() !== (tool.activePath ?? '').trim()
  const metaBits = [
    tool.detectedVersion ? `版本 ${tool.detectedVersion}` : null,
    tool.detail ?? null
  ].filter(Boolean)

  const save = async (next: string): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await onSavePath(tool.id, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const pickBinary = async (): Promise<void> => {
    setPicking(true)
    setError(null)
    try {
      const path = await pickEnvironmentBinary()
      if (path) setDraft(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPicking(false)
    }
  }

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
      <Stack spacing={1.5}>
        <Stack spacing={0.75} sx={{ minWidth: 0 }}>
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.75 }}
          >
            <Typography variant="body1" sx={{ fontWeight: 700 }}>
              {tool.label}
            </Typography>
            {statusChip(tool)}
            {sourceChip(tool)}
          </Stack>
          {metaBits.length > 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.45 }}>
              {metaBits.join(' · ')}
            </Typography>
          ) : null}
          {tool.status === 'missing' ? (
            <Typography variant="body2" color="text.secondary">
              本机未自动检测到。选择或填写绝对路径后保存，或稍后自行安装。
            </Typography>
          ) : null}
        </Stack>

        {tool.messages?.length ? (
          <Alert severity="info" variant="outlined">
            {tool.messages.join(' ')}
          </Alert>
        ) : null}

        <TextField
          fullWidth
          size="small"
          label="生效路径"
          value={draft}
          disabled={busy || saving || picking}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="/absolute/path/to/binary"
          helperText="绝对路径；保存后对该工具生效"
          slotProps={{
            input: {
              sx: { fontFamily: 'var(--font-mono)', fontSize: 13 },
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    edge="end"
                    size="small"
                    aria-label="浏览选择文件"
                    disabled={busy || saving || picking}
                    onClick={() => void pickBinary()}
                  >
                    {picking ? <CircularProgress size={16} /> : <BrowseIcon fontSize="small" />}
                  </IconButton>
                </InputAdornment>
              )
            }
          }}
        />

        {error ? (
          <Alert severity="error" variant="outlined">
            {error}
          </Alert>
        ) : null}

        <Box>
          <Button
            size="small"
            variant="contained"
            disabled={busy || saving || picking || !draft.trim() || !dirty}
            onClick={() => void save(draft.trim())}
            sx={{ minHeight: 36 }}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </Box>
      </Stack>
    </Paper>
  )
}

export type EnvironmentSettingsPanelProps = {
  snapshot: EnvironmentSnapshot | null
  loading: boolean
  redetecting: boolean
  onRedetect: () => Promise<void>
  onSavePath: (toolId: EnvironmentToolId, path: string | null) => Promise<void>
}

export function EnvironmentSettingsPanel({
  snapshot,
  loading,
  redetecting,
  onRedetect,
  onSavePath
}: EnvironmentSettingsPanelProps): React.JSX.Element {
  const tools = snapshot?.tools ?? []
  const readyCount = tools.filter((tool) => tool.status === 'ready').length
  const missingCount = tools.length - readyCount

  return (
    <Stack spacing={2}>
      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', md: 'center' },
          justifyContent: 'space-between',
          gap: 2,
          flexDirection: { xs: 'column', md: 'row' }
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5">环境</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            首次启动扫描本机工具并写入此处。未检测到不阻塞聊天；Wrappers / Analysis /
            出图用到时再要求就绪。
          </Typography>
        </Box>
        <Button
          size="small"
          variant="outlined"
          disabled={loading || redetecting}
          onClick={() => void onRedetect()}
          startIcon={redetecting ? <CircularProgress size={14} color="inherit" /> : undefined}
          sx={{ minHeight: 44, flexShrink: 0 }}
        >
          重新检测
        </Button>
      </Box>

      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
      >
        <Chip size="small" color="success" variant="outlined" label={`已就绪 ${readyCount}`} />
        <Chip size="small" variant="outlined" label={`未就绪 ${missingCount}`} />
        {snapshot?.scannedAt ? (
          <Typography variant="caption" color="text.secondary">
            最近扫描 {new Date(snapshot.scannedAt).toLocaleString()}
          </Typography>
        ) : null}
      </Stack>

      <Alert severity="info" variant="outlined">
        一键安装将在后续版本提供。当前可指定本机已有二进制；用到仍未就绪的工具时，会提示打开此页。
      </Alert>

      {loading && !snapshot ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress size={28} />
        </Box>
      ) : (
        <Stack spacing={1.25}>
          {tools.map((tool) => (
            <ToolCard
              key={`${tool.id}:${tool.activePath ?? ''}:${tool.detectedPath ?? ''}`}
              tool={tool}
              busy={loading || redetecting}
              onSavePath={onSavePath}
            />
          ))}
        </Stack>
      )}
    </Stack>
  )
}
