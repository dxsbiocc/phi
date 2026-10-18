import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from '../lib/connectorCopy'
import {
  Alert,
  Box,
  Button,
  FormControl,
  FormHelperText,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import type {
  LocalMcpRuntime,
  LocalMcpRuntimeOption
} from '../../../../../shared/mcpConnectorCatalog'
import { PhiIcons } from '../../../icons'
import {
  formatLocalConnectorArgv,
  parseLocalConnectorArgs,
  type LocalConnectorDraft,
  type LocalConnectorEnvRow
} from '../lib/localConnectorDraft'

export type { LocalMcpRuntimeOption } from '../../../../../shared/mcpConnectorCatalog'

export interface McpLocalConnectorFormProps {
  busy: boolean
  runtimes: readonly LocalMcpRuntimeOption[]
  runtimesLoading: boolean
  draft: LocalConnectorDraft
  onDraftChange: (draft: LocalConnectorDraft) => void
  runtimeHelperText?: string
}

function runtimeValue(runtime: LocalMcpRuntime): string {
  if (runtime.kind === 'host') return '__host__'
  if (runtime.kind === 'bun') return '__bun__'
  return runtime.ref
}

function runtimeFromValue(value: string): LocalMcpRuntime {
  if (value === '__host__') return { kind: 'host' }
  if (value === '__bun__') return { kind: 'bun' }
  return { kind: 'environment', ref: value }
}

function updateEnvironmentRow(
  rows: readonly LocalConnectorEnvRow[],
  id: string,
  patch: Partial<Pick<LocalConnectorEnvRow, 'name' | 'value'>>
): LocalConnectorEnvRow[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row))
}

export function McpLocalConnectorForm({
  busy,
  runtimes,
  runtimesLoading,
  draft,
  onDraftChange,
  runtimeHelperText
}: McpLocalConnectorFormProps): React.JSX.Element {
  useUiLanguage()

  const args = parseLocalConnectorArgs(draft.argsText)
  const bunRuntime = draft.runtime.kind === 'bun'
  const preview = formatLocalConnectorArgv(
    bunRuntime ? 'bun' : draft.command.trim(),
    bunRuntime ? [draft.command.trim(), ...args] : args
  )
  const disabled = busy

  function update(patch: Partial<LocalConnectorDraft>): void {
    onDraftChange({ ...draft, ...patch })
  }

  function addEnvironmentRow(): void {
    const nextIndex = draft.envRows.reduce((max, row) => {
      const parsed = Number(row.id.replace(/^env-/, ''))
      return Number.isFinite(parsed) ? Math.max(max, parsed) : max
    }, 0)
    update({ envRows: [...draft.envRows, { id: `env-${nextIndex + 1}`, name: '', value: '' }] })
  }

  return (
    <Stack spacing={2} sx={{ mt: 1 }}>
      <TextField
        autoFocus
        fullWidth
        disabled={disabled}
        label={resourceUi.name}
        value={draft.name}
        onChange={(event) => update({ name: event.target.value })}
        helperText={connectorCopy.localNameHint}
      />
      <FormControl fullWidth disabled={disabled || runtimesLoading}>
        <InputLabel id="mcp-local-runtime-label">{connectorCopy.runtimeLocation}</InputLabel>
        <Select
          labelId="mcp-local-runtime-label"
          label={connectorCopy.runtimeLocation}
          value={runtimeValue(draft.runtime)}
          onChange={(event) => {
            const runtime = runtimeFromValue(event.target.value)
            update({
              runtime,
              ...(runtime.kind === 'bun' && draft.command !== 'x' && draft.command !== 'run'
                ? { command: 'x' }
                : {})
            })
          }}
        >
          {runtimeValue(draft.runtime) ? null : (
            <MenuItem value="" disabled>
              {connectorCopy.chooseRuntime}
            </MenuItem>
          )}
          {runtimes.map((runtime) => (
            <MenuItem
              key={runtime.ref}
              value={runtime.kind === 'bun' || runtime.ref === 'bun' ? '__bun__' : runtime.ref}
            >
              {runtime.kind === 'bun' || runtime.ref === 'bun'
                ? connectorCopy.bundledBun
                : runtime.label}
            </MenuItem>
          ))}
          <MenuItem value="__host__">{connectorCopy.hostRuntime}</MenuItem>
        </Select>
        <FormHelperText>
          {runtimesLoading
            ? connectorCopy.loadingRuntimes
            : runtimeHelperText
              ? runtimeHelperText
              : runtimes.length === 0
                ? connectorCopy.noReadyRuntime
                : connectorCopy.readyRuntimesHint}
        </FormHelperText>
      </FormControl>
      {draft.runtime.kind === 'host' ? (
        <Alert severity="warning">{connectorCopy.hostWarning}</Alert>
      ) : null}
      {bunRuntime ? <Alert severity="warning">{connectorCopy.bunWarning}</Alert> : null}
      {bunRuntime ? (
        <FormControl fullWidth disabled={disabled}>
          <InputLabel id="mcp-local-bun-command-label">{connectorCopy.command}</InputLabel>
          <Select
            labelId="mcp-local-bun-command-label"
            label={connectorCopy.command}
            value={draft.command}
            onChange={(event) => update({ command: event.target.value })}
          >
            <MenuItem value="x">{connectorCopy.bunX}</MenuItem>
            <MenuItem value="run">{connectorCopy.bunRun}</MenuItem>
          </Select>
          <FormHelperText>{connectorCopy.bunCommandHint}</FormHelperText>
        </FormControl>
      ) : (
        <TextField
          fullWidth
          disabled={disabled}
          label={connectorCopy.command}
          value={draft.command}
          onChange={(event) => update({ command: event.target.value })}
          placeholder={
            draft.runtime.kind === 'host' ? connectorCopy.absoluteCommandExample : 'mcp-server'
          }
          helperText={
            draft.runtime.kind === 'host'
              ? connectorCopy.absoluteCommandHint
              : connectorCopy.environmentCommandHint
          }
        />
      )}
      <TextField
        fullWidth
        disabled={disabled}
        multiline
        minRows={3}
        label={connectorCopy.arguments}
        value={draft.argsText}
        onChange={(event) => update({ argsText: event.target.value })}
        helperText={
          bunRuntime
            ? draft.command === 'run'
              ? connectorCopy.scriptArgsHint
              : connectorCopy.bunXArgsHint
            : connectorCopy.argsHint
        }
      />
      <Box>
        <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
          <Typography variant="subtitle2" sx={{ flex: 1 }}>
            {connectorCopy.environmentVariables}
          </Typography>
          <Button
            type="button"
            size="small"
            disabled={disabled || draft.envRows.length >= 32}
            onClick={addEnvironmentRow}
            startIcon={<PhiIcons.action.add size={16} />}
          >
            {connectorCopy.addVariable}
          </Button>
        </Stack>
        <Stack spacing={1}>
          {draft.envRows.map((row, index) => (
            <Stack key={row.id} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
              <TextField
                disabled={disabled}
                size="small"
                label={connectorCopy.variableName(index)}
                value={row.name}
                onChange={(event) =>
                  update({
                    envRows: updateEnvironmentRow(draft.envRows, row.id, {
                      name: event.target.value
                    })
                  })
                }
                sx={{ flex: 1 }}
              />
              <TextField
                disabled={disabled}
                size="small"
                label={connectorCopy.variableValue(index)}
                value={row.value}
                onChange={(event) =>
                  update({
                    envRows: updateEnvironmentRow(draft.envRows, row.id, {
                      value: event.target.value
                    })
                  })
                }
                sx={{ flex: 1 }}
              />
              <IconButton
                type="button"
                disabled={disabled}
                aria-label={connectorCopy.removeVariable(index)}
                onClick={() =>
                  update({ envRows: draft.envRows.filter((item) => item.id !== row.id) })
                }
              >
                <PhiIcons.action.delete size={18} />
              </IconButton>
            </Stack>
          ))}
        </Stack>
        <FormHelperText>{connectorCopy.nonSensitiveVariablesHint}</FormHelperText>
      </Box>
      <TextField
        fullWidth
        disabled={disabled}
        label={connectorCopy.optionalWorkingDirectory}
        value={draft.cwd}
        onChange={(event) => update({ cwd: event.target.value })}
        helperText={connectorCopy.workingDirectoryHint}
      />
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
          {connectorCopy.commandPreview}
        </Typography>
        <Typography
          component="code"
          sx={{ display: 'block', overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)' }}
        >
          {preview || connectorCopy.commandPreviewHint}
        </Typography>
      </Box>
    </Stack>
  )
}
