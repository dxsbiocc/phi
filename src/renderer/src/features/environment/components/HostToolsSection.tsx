import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { TbRoute } from 'react-icons/tb'

import type { EnvironmentHostTool, EnvironmentToolId } from '../../../../../shared/environmentTypes'
import { PhiIcons } from '../../../icons'
import { HostEnvironmentItem } from './HostEnvironmentItem'

const BrowseIcon = PhiIcons.entity.folder

async function pickEnvironmentBinary(): Promise<string | null> {
  if (typeof window.api.pickEnvironmentBinary !== 'function') {
    throw new Error('文件选择接口不可用，请完全退出并重新打开 Phi 后再试')
  }
  return window.api.pickEnvironmentBinary()
}

function hostToolStatus(tool: EnvironmentHostTool): {
  label: string
  color: 'success' | 'warning' | 'default'
} {
  if (tool.status === 'invalid') return { label: '路径无效', color: 'warning' }
  if (tool.selected && tool.status === 'ready') {
    return { label: '已启用', color: 'success' }
  }
  if (tool.status === 'ready') return { label: '已检测到', color: 'success' }
  if (tool.status === 'not-configured') return { label: '未启用', color: 'default' }
  return { label: '未检测到', color: 'default' }
}

function DisclosureButton({
  expanded,
  label,
  onClick
}: {
  expanded: boolean
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      size="small"
      aria-expanded={expanded}
      onClick={onClick}
      endIcon={
        expanded ? <PhiIcons.action.collapse size={16} /> : <PhiIcons.action.expand size={16} />
      }
    >
      {expanded ? '收起' : label}
    </Button>
  )
}

function NextflowHostToolCard({
  tool,
  busy,
  onSavePath
}: {
  tool: EnvironmentHostTool & { id: 'nextflow' }
  busy: boolean
  onSavePath: (toolId: EnvironmentToolId, path: string | null) => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState(tool.path ?? tool.detectedPath ?? '')
  const [expanded, setExpanded] = useState(tool.status === 'invalid')
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = hostToolStatus(tool)
  const savedPath = tool.path ?? ''
  const dirty = draft.trim() !== savedPath.trim()
  const summary = tool.selected
    ? [tool.version, tool.path].filter(Boolean).join(' · ') || '正在使用本机版本'
    : tool.detectedPath
      ? [tool.version, '检测到本机版本，可选择启用'].filter(Boolean).join(' · ')
      : '默认使用 Phi 托管版本'

  const save = async (path: string | null): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await onSavePath(tool.id, path)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPicking(false)
    }
  }

  return (
    <HostEnvironmentItem
      id="nextflow"
      icon={<TbRoute aria-hidden size={23} />}
      title={tool.label}
      summary={summary}
      status={status}
      contextLabel="本机（非托管）"
      expanded={expanded}
      action={
        <DisclosureButton
          expanded={expanded}
          label="配置"
          onClick={() => setExpanded((value) => !value)}
        />
      }
      details={
        <Stack spacing={1.25}>
          <Typography variant="body2" color="text.secondary">
            只有明确保存这里的路径后，Wrapper 才会使用本机 Nextflow。
          </Typography>
          <TextField
            fullWidth
            size="small"
            label="本机 Nextflow 路径"
            value={draft}
            disabled={busy || saving || picking}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="/absolute/path/to/nextflow"
            helperText="保存时检查版本；过旧版本不会启用"
            slotProps={{
              input: {
                sx: { fontFamily: 'var(--font-mono)', fontSize: 13 },
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      edge="end"
                      size="small"
                      aria-label="浏览选择 Nextflow"
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
          {tool.messages?.length ? (
            <Alert severity="info" variant="outlined">
              {tool.messages.join(' ')}
            </Alert>
          ) : null}
          {error ? (
            <Alert severity="error" variant="outlined">
              {error}
            </Alert>
          ) : null}
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="contained"
              disabled={busy || saving || picking || !draft.trim() || !dirty}
              onClick={() => void save(draft.trim())}
            >
              {saving ? '保存中…' : '启用此本机版本'}
            </Button>
            {tool.selected ? (
              <Button
                size="small"
                disabled={busy || saving || picking}
                onClick={() => void save(null)}
              >
                恢复托管版本
              </Button>
            ) : null}
          </Stack>
        </Stack>
      }
    />
  )
}

function JupyterHostToolCard({
  tool,
  busy,
  onSavePath
}: {
  tool: EnvironmentHostTool & { id: 'jupyter' }
  busy: boolean
  onSavePath: (toolId: EnvironmentToolId, path: string | null) => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState(tool.path ?? tool.detectedPath ?? '')
  const [expanded, setExpanded] = useState(tool.status === 'invalid')
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = hostToolStatus(tool)
  const kernels = tool.kernels ?? []
  const savedPath = tool.path ?? ''
  const dirty = draft.trim() !== savedPath.trim()
  const summary = tool.selected
    ? [tool.version, tool.path].filter(Boolean).join(' · ') || '正在使用本机 Jupyter Server'
    : tool.detectedPath
      ? `${kernels.length} 个 kernel · 检测到本机 Server，可选择启用`
      : `${kernels.length} 个本机 kernel · 默认使用托管 Server`

  const save = async (path: string | null): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await onSavePath(tool.id, path)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPicking(false)
    }
  }

  return (
    <HostEnvironmentItem
      id="jupyter"
      icon={<PhiIcons.nav.runtime size={22} />}
      title="Jupyter"
      summary={summary}
      status={status}
      contextLabel="本机（非托管）"
      expanded={expanded}
      action={
        <DisclosureButton
          expanded={expanded}
          label="配置"
          onClick={() => setExpanded((value) => !value)}
        />
      }
      details={
        <Stack spacing={1.25}>
          <Typography variant="body2" color="text.secondary">
            明确启用后，Notebook 会优先使用该本机 Jupyter Server；kernel 仍可单独选择。
          </Typography>
          <TextField
            fullWidth
            size="small"
            label="本机 Jupyter 路径"
            value={draft}
            disabled={busy || saving || picking}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="/absolute/path/to/jupyter"
            helperText="保存时会验证 Jupyter Server 与 kernelspec"
            slotProps={{
              input: {
                sx: { fontFamily: 'var(--font-mono)', fontSize: 13 },
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      edge="end"
                      size="small"
                      aria-label="浏览选择 Jupyter"
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
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="contained"
              disabled={busy || saving || picking || !draft.trim() || !dirty}
              onClick={() => void save(draft.trim())}
            >
              {saving ? '保存中…' : '优先使用本机版本'}
            </Button>
            {tool.selected ? (
              <Button
                size="small"
                disabled={busy || saving || picking}
                onClick={() => void save(null)}
              >
                恢复托管版本
              </Button>
            ) : null}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            本机 kernels · {kernels.length} 个
          </Typography>
          {kernels.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              未发现本机 kernels。
            </Typography>
          ) : (
            <Stack
              direction="row"
              spacing={0.75}
              useFlexGap
              sx={{ flexWrap: 'wrap', rowGap: 0.75 }}
            >
              {kernels.map((kernel) => (
                <Chip
                  key={kernel.id}
                  size="small"
                  label={`${kernel.displayName} · ${kernel.language}`}
                  title={kernel.path}
                />
              ))}
            </Stack>
          )}
          {tool.messages?.map((message) => (
            <Typography key={message} variant="caption" color="text.secondary">
              {message}
            </Typography>
          ))}
        </Stack>
      }
    />
  )
}

export function HostToolsSection({
  tools,
  busy,
  onSavePath
}: {
  tools: readonly EnvironmentHostTool[]
  busy: boolean
  onSavePath: (toolId: EnvironmentToolId, path: string | null) => Promise<void>
}): React.JSX.Element {
  return (
    <Stack component="section" spacing={1} aria-labelledby="host-tools-title">
      <Box>
        <Typography id="host-tools-title" variant="h6">
          可选的本机工具
        </Typography>
        <Typography variant="body2" color="text.secondary">
          默认使用托管环境；只有明确启用时才会使用本机版本。
        </Typography>
      </Box>

      {tools.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          尚未检测到可选的本机工具。
        </Typography>
      ) : (
        <Stack spacing={1}>
          {tools.map((tool) =>
            tool.id === 'nextflow' ? (
              <NextflowHostToolCard
                key={`${tool.id}:${tool.path ?? ''}:${tool.detectedPath ?? ''}`}
                tool={tool as EnvironmentHostTool & { id: 'nextflow' }}
                busy={busy}
                onSavePath={onSavePath}
              />
            ) : (
              <JupyterHostToolCard
                key={`${tool.id}:${tool.path ?? ''}:${tool.detectedPath ?? ''}`}
                tool={tool as EnvironmentHostTool & { id: 'jupyter' }}
                busy={busy}
                onSavePath={onSavePath}
              />
            )
          )}
        </Stack>
      )}
    </Stack>
  )
}
