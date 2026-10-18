import { useUiLanguage } from '../../../lib/i18n'
import { remoteSetupCopy } from '../lib/remoteSetupCopy'
import { Box, MenuItem, Stack, TextField, Typography } from '@mui/material'

import type { HpcDraft } from '../lib/remoteHpcDraft'

interface Props {
  value: HpcDraft
  onChange: (next: HpcDraft) => void
  advancedOnly?: boolean
}

/** Site-specific scheduler, controller and runtime settings for one project binding. */
export function WrapperHpcSettingsFields({
  value,
  onChange,
  advancedOnly = false
}: Props): React.JSX.Element {
  useUiLanguage()
  const slurm = value.scheduler === 'slurm'
  const monoInput = {
    '& input, & textarea': { fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }
  }
  return (
    <Stack spacing={2}>
      {!advancedOnly && (
        <Box>
          <Typography variant="subtitle2">{remoteSetupCopy.executionMode}</Typography>
          <Typography variant="caption" color="text.secondary">
            {remoteSetupCopy.nextflowBackgroundHelp}
          </Typography>
        </Box>
      )}
      <TextField
        select
        size="small"
        fullWidth
        label={remoteSetupCopy.nextflowControllerLocation}
        value={value.controller}
        onChange={(event) =>
          onChange({ ...value, controller: event.target.value as HpcDraft['controller'] })
        }
        helperText={
          value.controller === 'login'
            ? remoteSetupCopy.loginControllerHelp
            : remoteSetupCopy.slurmControllerHelp
        }
      >
        <MenuItem value="login">{remoteSetupCopy.loginNodeBackground}</MenuItem>
        {slurm && <MenuItem value="sbatch">{remoteSetupCopy.submitAsSlurmJob}</MenuItem>}
      </TextField>
      {value.controller === 'sbatch' && (
        <TextField
          size="small"
          fullWidth
          label={remoteSetupCopy.controllerSbatchOptions}
          value={value.controllerOptions}
          onChange={(event) => onChange({ ...value, controllerOptions: event.target.value })}
          placeholder="--time=7-00:00:00 --mem=8G"
          sx={monoInput}
        />
      )}
      {!advancedOnly && (
        <Stack direction="row" spacing={1.5}>
          <TextField
            select
            size="small"
            fullWidth
            label={remoteSetupCopy.scheduler}
            value={value.scheduler}
            onChange={(event) =>
              onChange({ ...value, scheduler: event.target.value as HpcDraft['scheduler'] })
            }
            helperText={slurm ? remoteSetupCopy.slurmTasksHelp : remoteSetupCopy.directTasksHelp}
          >
            <MenuItem value="slurm">{remoteSetupCopy.slurmCluster}</MenuItem>
            <MenuItem value="local">{remoteSetupCopy.runDirectlyOnHost}</MenuItem>
          </TextField>
          <TextField
            select
            size="small"
            fullWidth
            label={remoteSetupCopy.softwareEnvironment}
            value={value.runtime}
            onChange={(event) =>
              onChange({ ...value, runtime: event.target.value as HpcDraft['runtime'] })
            }
          >
            <MenuItem value="singularity">Singularity / Apptainer</MenuItem>
            <MenuItem value="conda">Conda</MenuItem>
            <MenuItem value="docker">Docker</MenuItem>
          </TextField>
        </Stack>
      )}
      {slurm && (
        <>
          <Stack direction="row" spacing={1.5}>
            <TextField
              size="small"
              fullWidth
              label={remoteSetupCopy.queuePartition}
              value={value.queue}
              onChange={(event) => onChange({ ...value, queue: event.target.value })}
              placeholder={remoteSetupCopy.defaultQueueHelp}
            />
            <TextField
              size="small"
              fullWidth
              label={remoteSetupCopy.account}
              value={value.account}
              onChange={(event) => onChange({ ...value, account: event.target.value })}
            />
          </Stack>
          <Stack direction="row" spacing={1.5}>
            <TextField
              size="small"
              fullWidth
              label={remoteSetupCopy.extraSbatchOptions}
              value={value.clusterOptions}
              onChange={(event) => onChange({ ...value, clusterOptions: event.target.value })}
              placeholder="--qos=normal"
              sx={monoInput}
            />
            <TextField
              size="small"
              label={remoteSetupCopy.maxQueuedJobs}
              value={value.queueSize}
              onChange={(event) => onChange({ ...value, queueSize: event.target.value })}
              placeholder={remoteSetupCopy.unlimited}
              sx={{ minWidth: 150 }}
            />
          </Stack>
        </>
      )}
      <TextField
        size="small"
        fullWidth
        label={remoteSetupCopy.singularityCacheDirectory}
        value={value.singularityCacheDir}
        onChange={(event) => onChange({ ...value, singularityCacheDir: event.target.value })}
        placeholder="/shared/lab/singularity"
        sx={monoInput}
      />
      <TextField
        size="small"
        fullWidth
        label={remoteSetupCopy.nextflowPath}
        value={value.nextflowBin}
        onChange={(event) => onChange({ ...value, nextflowBin: event.target.value })}
        placeholder={remoteSetupCopy.nextflowPathHelp}
        sx={monoInput}
      />
      <TextField
        size="small"
        fullWidth
        multiline
        minRows={2}
        label={remoteSetupCopy.setupCommands}
        value={value.setupText}
        onChange={(event) => onChange({ ...value, setupText: event.target.value })}
        placeholder={'module load java\nmodule load nextflow'}
        helperText={remoteSetupCopy.setupCommandsHelp}
        sx={monoInput}
      />
      <TextField
        size="small"
        fullWidth
        multiline
        minRows={2}
        label={remoteSetupCopy.additionalNextflowConfiguration}
        value={value.nextflowConfig}
        onChange={(event) => onChange({ ...value, nextflowConfig: event.target.value })}
        placeholder={"process.conda = '/shared/envs/rnaseq'"}
        helperText={remoteSetupCopy.nextflowConfigurationHelp}
        sx={monoInput}
      />
    </Stack>
  )
}
