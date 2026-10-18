import { useUiLanguage } from '../../../lib/i18n'
import { remoteSetupCopy } from '../lib/remoteSetupCopy'
import { useState } from 'react'
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
  {
    id: 'nextflow',
    label: 'Nextflow',
    get managed() {
      return remoteSetupCopy.managedByPhi
    }
  },
  {
    id: 'jupyter',
    label: 'Jupyter',
    get managed() {
      return remoteSetupCopy.jupyterDetection
    }
  },
  {
    id: 'micromamba',
    label: 'micromamba',
    get managed() {
      return remoteSetupCopy.installedInRuntimeRoot
    }
  },
  {
    id: 'docker',
    label: 'Docker',
    get managed() {
      return remoteSetupCopy.detectFromServerPath
    }
  }
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

function toolPathError(value: string, label: string): string | null {
  const error = remoteEnvironmentPathError(value, label)
  if (!error) return null
  if (error === `${label} must not contain NUL or newline characters`) {
    return remoteSetupCopy.pathControlCharacterError(label)
  }
  if (error === `${label} must be an absolute path`) return remoteSetupCopy.pathAbsoluteError(label)
  if (error === `${label} must not contain .. path segments`) {
    return remoteSetupCopy.pathParentSegmentError(label)
  }
  return error
}

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
  useUiLanguage()
  const [runtimeRoot, setRuntimeRoot] = useState(host.runtimeRoot ?? '')
  const [toolPaths, setToolPaths] = useState<RemoteEnvironmentToolPaths>(host.toolPaths ?? {})
  const pathErrors = (() => {
    const entries = TOOL_FIELDS.flatMap(({ id, label }) => {
      const value = toolPaths[id] ?? ''
      const error =
        toolPathError(value, remoteSetupCopy.toolPath(label)) ??
        (id === 'docker' && value.trim() && !value.trim().endsWith('/docker')
          ? remoteSetupCopy.dockerPathError
          : null)
      return error ? [[id, error] as const] : []
    })
    return Object.fromEntries(entries) as Partial<Record<RemoteEnvironmentToolId, string>>
  })()
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
          {remoteSetupCopy.environmentSettings}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {remoteSetupCopy.environmentOverrideHelp}
        </Typography>
      </Box>

      <TextField
        fullWidth
        size="small"
        label={remoteSetupCopy.defaultRuntimeEnvironment}
        value={runtimeRoot}
        error={Boolean(runtimeError)}
        disabled={busy}
        placeholder="~/.phi/runtime"
        helperText={runtimeError ?? remoteSetupCopy.defaultRuntimeRoot}
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
            label={remoteSetupCopy.toolPath(label)}
            value={toolPaths[id] ?? ''}
            error={Boolean(pathErrors[id])}
            disabled={busy}
            placeholder={id === 'jupyter' ? remoteSetupCopy.autoDetect : remoteSetupCopy.phiManaged}
            helperText={pathErrors[id] ?? remoteSetupCopy.defaultValue(managed)}
            onChange={(event) =>
              setToolPaths((current) => ({ ...current, [id]: event.target.value }))
            }
            slotProps={PATH_INPUT_SLOT_PROPS}
          />
        ))}
      </Box>

      <Stack direction="row" spacing={1}>
        <Button variant="contained" disabled={busy || invalid || !dirty} onClick={() => save()}>
          {busy ? remoteSetupCopy.saving : remoteSetupCopy.saveEnvironmentSettings}
        </Button>
        {(hasOverrides || dirty) && (
          <Button disabled={busy} onClick={() => save(true)}>
            {remoteSetupCopy.restoreDefaults}
          </Button>
        )}
      </Stack>
    </Stack>
  )
}
