import { useState, type ReactNode } from 'react'
import Alert from '@mui/material/Alert'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { TbRoute } from 'react-icons/tb'

import type { EnvironmentHostTool, EnvironmentToolId } from '../../../../../shared/environmentTypes'
import { PhiIcons } from '../../../icons'
import { hostToolDisplayVersion, hostToolPresentation } from '../lib/hostEnvironmentStatus'
import { HostEnvironmentItem } from './HostEnvironmentItem'

const BrowseIcon = PhiIcons.entity.folder
const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu')

async function pickEnvironmentBinary(): Promise<string | null> {
  if (typeof window.api.pickEnvironmentBinary !== 'function') {
    throw new Error('文件选择接口不可用，请完全退出并重新打开 Phi 后再试')
  }
  return window.api.pickEnvironmentBinary()
}

function readableToolError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const clean = raw
    .replace(ansiEscape, '')
    .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
    .trim()
  if (/Unable to locate a Java Runtime|Nextflow needs a Java virtual machine/iu.test(clean)) {
    return '无法启用本机 Nextflow：没有找到 Java。请选择包含 Java 的 Nextflow 环境，或继续使用 Phi 托管环境。'
  }
  return clean
}

type HostToolChoiceCardProps = {
  tool: EnvironmentHostTool
  title: string
  icon: ReactNode
  pathLabel: string
  placeholder: string
  summary?: string
  busy: boolean
  children?: ReactNode
  onSavePath: (toolId: EnvironmentToolId, path: string | null) => Promise<void>
}

function HostToolChoiceCard({
  tool,
  title,
  icon,
  pathLabel,
  placeholder,
  summary,
  busy,
  children,
  onSavePath
}: HostToolChoiceCardProps): React.JSX.Element {
  const [draft, setDraft] = useState(tool.path ?? tool.detectedPath ?? '')
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = hostToolPresentation(tool)
  const working = busy || saving || picking

  const save = async (path: string | null): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await onSavePath(tool.id, path)
    } catch (cause) {
      setError(readableToolError(cause))
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
      setError(readableToolError(cause))
    } finally {
      setPicking(false)
    }
  }

  return (
    <HostEnvironmentItem
      id={tool.id}
      icon={icon}
      title={title}
      summary={summary}
      status={status}
      contextLabel="本机工具"
      choiceSelected={tool.selected}
      action={
        <Switch
          checked={tool.selected}
          disabled={working || (!tool.selected && !draft.trim())}
          onChange={(_, checked) => void save(checked ? draft.trim() : null)}
          slotProps={{ input: { 'aria-label': `启用本机 ${title}` } }}
        />
      }
      details={
        <Stack spacing={1.25}>
          <TextField
            fullWidth
            size="small"
            label={pathLabel}
            value={draft}
            disabled={working || tool.selected}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            helperText={
              tool.selected ? '切换到 Phi 托管环境后可修改路径' : '开启右侧开关以使用此路径'
            }
            slotProps={{
              input: {
                sx: { fontFamily: 'var(--font-mono)', fontSize: 13 },
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      edge="end"
                      size="small"
                      aria-label={`浏览选择 ${title}`}
                      disabled={working || tool.selected}
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
            <Alert severity={tool.status === 'invalid' ? 'warning' : 'info'} variant="outlined">
              {tool.messages.join(' ')}
            </Alert>
          ) : null}
          {error ? (
            <Alert severity="error" variant="outlined">
              {error}
            </Alert>
          ) : null}
          {children}
        </Stack>
      }
    />
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
  const version = hostToolDisplayVersion(tool)
  const summary = version ? `版本 ${version}` : undefined
  return (
    <HostToolChoiceCard
      tool={tool}
      title="Nextflow"
      icon={<TbRoute aria-hidden size={23} />}
      pathLabel="本机 Nextflow 路径"
      placeholder="/absolute/path/to/nextflow"
      summary={summary}
      busy={busy}
      onSavePath={onSavePath}
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
  const kernels = tool.kernels ?? []
  const summary = tool.selected
    ? [tool.version ? `版本 ${tool.version}` : undefined, `${kernels.length} 个 kernel`]
        .filter(Boolean)
        .join(' · ')
    : tool.status === 'ready'
      ? tool.detectedPath
        ? `${kernels.length} 个 kernel · 本机 Server 可用`
        : `${kernels.length} 个本机 kernel`
      : tool.detectedPath
        ? '已找到 Jupyter，但 Server 不可用'
        : '未发现本机 Jupyter'
  return (
    <HostToolChoiceCard
      tool={tool}
      title="Jupyter"
      icon={<PhiIcons.nav.runtime size={22} />}
      pathLabel="本机 Jupyter 路径"
      placeholder="/absolute/path/to/jupyter"
      summary={summary}
      busy={busy}
      onSavePath={onSavePath}
    >
      <Typography variant="caption" color="text.secondary">
        本机 kernels · {kernels.length} 个
      </Typography>
      {kernels.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          未发现本机 kernels。
        </Typography>
      ) : (
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
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
    </HostToolChoiceCard>
  )
}

export function HostToolsList({
  tools,
  busy,
  onSavePath
}: {
  tools: readonly EnvironmentHostTool[]
  busy: boolean
  onSavePath: (toolId: EnvironmentToolId, path: string | null) => Promise<void>
}): React.JSX.Element {
  if (tools.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        尚未完成本机工具检测。
      </Typography>
    )
  }
  return (
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
  )
}
