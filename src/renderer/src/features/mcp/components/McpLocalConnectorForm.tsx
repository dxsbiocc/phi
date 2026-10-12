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
        label="名称"
        value={draft.name}
        onChange={(event) => update({ name: event.target.value })}
        helperText="使用 2–64 位字母、数字、下划线或连字符，并以字母开头"
      />
      <FormControl fullWidth disabled={disabled || runtimesLoading}>
        <InputLabel id="mcp-local-runtime-label">运行位置</InputLabel>
        <Select
          labelId="mcp-local-runtime-label"
          label="运行位置"
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
              请选择运行位置
            </MenuItem>
          )}
          {runtimes.map((runtime) => (
            <MenuItem
              key={runtime.ref}
              value={runtime.kind === 'bun' || runtime.ref === 'bun' ? '__bun__' : runtime.ref}
            >
              {runtime.label}
            </MenuItem>
          ))}
          <MenuItem value="__host__">本机命令（不隔离）</MenuItem>
        </Select>
        <FormHelperText>
          {runtimesLoading
            ? '正在加载可用运行环境…'
            : runtimeHelperText
              ? runtimeHelperText
              : runtimes.length === 0
                ? '没有已就绪的 Phi 运行环境；可选择本机命令'
                : 'Phi 环境仅列出已经构建并就绪的版本'}
        </FormHelperText>
      </FormControl>
      {draft.runtime.kind === 'host' ? (
        <Alert severity="warning">将直接在本机运行，不使用 Phi 隔离环境</Alert>
      ) : null}
      {bunRuntime ? (
        <Alert severity="warning">
          由 Phi 内置 Bun 以 Node 兼容模式运行；个别依赖可能不兼容。x
          方式每次启动会联网解析依赖，版本不锁定。
        </Alert>
      ) : null}
      {bunRuntime ? (
        <FormControl fullWidth disabled={disabled}>
          <InputLabel id="mcp-local-bun-command-label">命令</InputLabel>
          <Select
            labelId="mcp-local-bun-command-label"
            label="命令"
            value={draft.command}
            onChange={(event) => update({ command: event.target.value })}
          >
            <MenuItem value="x">x（运行 npm 包）</MenuItem>
            <MenuItem value="run">run（运行脚本）</MenuItem>
          </Select>
          <FormHelperText>x（运行 npm 包）；run（运行脚本）</FormHelperText>
        </FormControl>
      ) : (
        <TextField
          fullWidth
          disabled={disabled}
          label="命令"
          value={draft.command}
          onChange={(event) => update({ command: event.target.value })}
          placeholder={draft.runtime.kind === 'host' ? '/绝对路径/to/mcp-server' : 'mcp-server'}
          helperText={
            draft.runtime.kind === 'host'
              ? '请输入可执行文件的绝对路径'
              : '请输入环境 PATH 中的命令名'
          }
        />
      )}
      <TextField
        fullWidth
        disabled={disabled}
        multiline
        minRows={3}
        label="参数"
        value={draft.argsText}
        onChange={(event) => update({ argsText: event.target.value })}
        helperText={
          bunRuntime
            ? draft.command === 'run'
              ? '脚本绝对路径，每行一个参数'
              : '例如 --bun 加 包名@版本，每行一个'
            : '每行一个参数；空行会被忽略，不会经过 shell 解析'
        }
      />
      <Box>
        <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
          <Typography variant="subtitle2" sx={{ flex: 1 }}>
            环境变量
          </Typography>
          <Button
            type="button"
            size="small"
            disabled={disabled || draft.envRows.length >= 32}
            onClick={addEnvironmentRow}
            startIcon={<PhiIcons.action.add size={16} />}
          >
            添加变量
          </Button>
        </Stack>
        <Stack spacing={1}>
          {draft.envRows.map((row, index) => (
            <Stack key={row.id} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
              <TextField
                disabled={disabled}
                size="small"
                label={`变量 ${index + 1} 名称`}
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
                label={`变量 ${index + 1} 值`}
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
                aria-label={`移除环境变量 ${index + 1}`}
                onClick={() =>
                  update({ envRows: draft.envRows.filter((item) => item.id !== row.id) })
                }
              >
                <PhiIcons.action.delete size={18} />
              </IconButton>
            </Stack>
          ))}
        </Stack>
        <FormHelperText>仅用于非敏感配置，不要在此填写密钥</FormHelperText>
      </Box>
      <TextField
        fullWidth
        disabled={disabled}
        label="工作目录（可选）"
        value={draft.cwd}
        onChange={(event) => update({ cwd: event.target.value })}
        helperText="必须是已存在目录的绝对路径"
      />
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
          命令预览
        </Typography>
        <Typography
          component="code"
          sx={{ display: 'block', overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)' }}
        >
          {preview || '填写命令后显示完整 argv'}
        </Typography>
      </Box>
    </Stack>
  )
}
