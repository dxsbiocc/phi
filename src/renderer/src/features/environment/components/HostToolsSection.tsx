import { environmentUi } from '../lib/environmentUi'
import { useUiLanguage } from '../../../lib/i18n'
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
import { errorMessage } from '../../../../../shared/errorCodes'
import { PhiIcons } from '../../../icons'
import { hostToolDisplayVersion, hostToolPresentation } from '../lib/hostEnvironmentStatus'
import { HostEnvironmentItem } from './HostEnvironmentItem'

const BrowseIcon = PhiIcons.entity.folder
const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu')

async function pickEnvironmentBinary(): Promise<string | null> {
  if (typeof window.api.pickEnvironmentBinary !== 'function') {
    throw new Error(environmentUi.theFilePickerIsUnavailableQuitAndReopen)
  }
  return window.api.pickEnvironmentBinary()
}

function readableToolError(cause: unknown): string {
  const raw = errorMessage(cause)
  const clean = raw
    .replace(ansiEscape, '')
    .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
    .trim()
  if (/Unable to locate a Java Runtime|Nextflow needs a Java virtual machine/iu.test(clean)) {
    return environmentUi.cannotEnableLocalNextflowBecauseJavaWasNot
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
  useUiLanguage()
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
      contextLabel={environmentUi.localTools}
      choiceSelected={tool.selected}
      action={
        <Switch
          checked={tool.selected}
          disabled={working || (!tool.selected && !draft.trim())}
          onChange={(_, checked) => void save(checked ? draft.trim() : null)}
          slotProps={{ input: { 'aria-label': environmentUi.enableLocalValue(title) } }}
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
              tool.selected
                ? environmentUi.switchToThePhiManagedEnvironmentToEdit
                : environmentUi.enableTheSwitchOnTheRightToUse
            }
            slotProps={{
              input: {
                sx: { fontFamily: 'var(--font-mono)', fontSize: 13 },
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      edge="end"
                      size="small"
                      aria-label={environmentUi.browseForValue(title)}
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
  useUiLanguage()
  const version = hostToolDisplayVersion(tool)
  const summary = version ? environmentUi.versionValue(version) : undefined
  return (
    <HostToolChoiceCard
      tool={tool}
      title="Nextflow"
      icon={<TbRoute aria-hidden size={23} />}
      pathLabel={environmentUi.localNextflowPath}
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
  useUiLanguage()
  const kernels = tool.kernels ?? []
  const summary = tool.selected
    ? [
        tool.version ? environmentUi.versionValue(tool.version) : undefined,
        environmentUi.valueKernels(kernels.length)
      ]
        .filter(Boolean)
        .join(' · ')
    : tool.status === 'ready'
      ? tool.detectedPath
        ? environmentUi.valueKernelsLocalServerAvailable(kernels.length)
        : environmentUi.valueLocalKernels(kernels.length)
      : tool.detectedPath
        ? environmentUi.jupyterFoundButTheServerIsUnavailable
        : environmentUi.noLocalJupyterFound
  return (
    <HostToolChoiceCard
      tool={tool}
      title="Jupyter"
      icon={<PhiIcons.nav.runtime size={22} />}
      pathLabel={environmentUi.localJupyterPath}
      placeholder="/absolute/path/to/jupyter"
      summary={summary}
      busy={busy}
      onSavePath={onSavePath}
    >
      <Typography variant="caption" color="text.secondary">
        {environmentUi.localKernels} {kernels.length} {environmentUi.countSuffix}
      </Typography>
      {kernels.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {environmentUi.noLocalKernelsFound}
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
  useUiLanguage()
  if (tools.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {environmentUi.localToolDetectionHasNotFinished}
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
