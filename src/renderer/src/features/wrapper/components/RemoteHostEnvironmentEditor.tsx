import { useMemo, useState } from 'react'
import { Box, Button, Stack, TextField, Typography } from '@mui/material'

import type { RemoteHostProfile } from '../../../types'
import {
  REMOTE_ENVIRONMENT_TOOL_IDS,
  remoteEnvironmentPathError,
  type RemoteEnvironmentSettingInput,
  type RemoteEnvironmentToolId,
  type RemoteEnvironmentToolPaths
} from '../../../../../shared/remoteEnvironmentTypes'
import {
  normalizeRemoteRuntimeRootValue,
  remoteRuntimeRootValueError
} from '../lib/remoteRuntimeRootUi'

const TOOL_FIELDS: ReadonlyArray<{
  id: RemoteEnvironmentToolId
  label: string
  managed: string
}> = [
  { id: 'nextflow', label: 'Nextflow', managed: '由 Phi 托管' },
  { id: 'jupyter', label: 'Jupyter', managed: '由 Phi 托管' },
  { id: 'micromamba', label: 'micromamba', managed: '由 Phi 安装在运行时目录' },
  { id: 'docker', label: 'Docker', managed: '从服务器 PATH 自动检测' }
]

const PATH_INPUT_SLOT_PROPS = {
  input: { sx: { fontFamily: 'var(--font-mono)', fontSize: 13 } },
  inputLabel: {
    shrink: true,
    sx: {
      bgcolor: 'background.paper',
      px: 0.5,
      ml: -0.5,
      zIndex: 1
    }
  }
} as const

function trimmedToolPaths(paths: RemoteEnvironmentToolPaths): RemoteEnvironmentToolPaths {
  return Object.fromEntries(
    REMOTE_ENVIRONMENT_TOOL_IDS.flatMap((id) => {
      const path = paths[id]?.trim()
      return path ? [[id, path]] : []
    })
  )
}

export interface RemoteHostEnvironmentEditorProps {
  host: RemoteHostProfile
  busy: boolean
  onSave: (host: RemoteHostProfile, input: RemoteEnvironmentSettingInput) => void
}

export function RemoteHostEnvironmentEditor({
  host,
  busy,
  onSave
}: RemoteHostEnvironmentEditorProps): React.JSX.Element {
  const [runtimeRoot, setRuntimeRoot] = useState(host.runtimeRoot ?? '')
  const [toolPaths, setToolPaths] = useState<RemoteEnvironmentToolPaths>(host.toolPaths ?? {})
  const pathErrors = useMemo(() => {
    const entries = TOOL_FIELDS.flatMap(({ id, label }) => {
      const value = toolPaths[id] ?? ''
      const error =
        remoteEnvironmentPathError(value, `${label} 路径`) ??
        (id === 'docker' && value.trim() && !value.trim().endsWith('/docker')
          ? 'Docker 路径必须指向名为 docker 的可执行文件'
          : null)
      return error ? [[id, error] as const] : []
    })
    return Object.fromEntries(entries) as Partial<Record<RemoteEnvironmentToolId, string>>
  }, [toolPaths])
  const normalizedRuntimeRoot = normalizeRemoteRuntimeRootValue(runtimeRoot.trim())
  const runtimeError = remoteRuntimeRootValueError(runtimeRoot.trim())
  const normalizedPaths = trimmedToolPaths(toolPaths)
  const dirty =
    (normalizedRuntimeRoot ?? '') !== (host.runtimeRoot ?? '') ||
    JSON.stringify(normalizedPaths) !== JSON.stringify(host.toolPaths ?? {})
  const hasOverrides = Boolean(host.runtimeRoot || Object.keys(host.toolPaths ?? {}).length)
  const invalid = Boolean(runtimeError || Object.keys(pathErrors).length)

  const save = (useDefaults = false): void => {
    onSave(
      host,
      useDefaults
        ? { toolPaths: {} }
        : {
            ...(normalizedRuntimeRoot ? { runtimeRoot: normalizedRuntimeRoot } : {}),
            toolPaths: normalizedPaths
          }
    )
  }

  return (
    <Stack spacing={2.25}>
      <Box>
        <Typography variant="h6" sx={{ fontWeight: 750 }}>
          环境配置
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          留空时由 Phi 管理；只有明确填写的路径会覆盖默认值。
        </Typography>
      </Box>

      <TextField
        fullWidth
        size="small"
        label="默认运行环境"
        value={runtimeRoot}
        error={Boolean(runtimeError)}
        disabled={busy}
        placeholder="~/.phi/runtime"
        helperText={runtimeError ?? '默认：~/.phi/runtime'}
        onChange={(event) => setRuntimeRoot(event.target.value)}
        slotProps={PATH_INPUT_SLOT_PROPS}
      />

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
          gap: 2
        }}
      >
        {TOOL_FIELDS.map(({ id, label, managed }) => (
          <TextField
            key={id}
            fullWidth
            size="small"
            label={`${label} 路径`}
            value={toolPaths[id] ?? ''}
            error={Boolean(pathErrors[id])}
            disabled={busy}
            placeholder="由 Phi 管理"
            helperText={pathErrors[id] ?? `默认：${managed}`}
            onChange={(event) =>
              setToolPaths((current) => ({ ...current, [id]: event.target.value }))
            }
            slotProps={PATH_INPUT_SLOT_PROPS}
          />
        ))}
      </Box>

      <Stack direction="row" spacing={1}>
        <Button variant="contained" disabled={busy || invalid || !dirty} onClick={() => save()}>
          {busy ? '保存中…' : '保存环境配置'}
        </Button>
        {(hasOverrides || dirty) && (
          <Button disabled={busy} onClick={() => save(true)}>
            恢复 Phi 默认值
          </Button>
        )}
      </Stack>
    </Stack>
  )
}
