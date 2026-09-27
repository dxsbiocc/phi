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
  const slurm = value.scheduler === 'slurm'
  const monoInput = {
    '& input, & textarea': { fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }
  }
  return (
    <Stack spacing={2}>
      {!advancedOnly && (
        <Box>
          <Typography variant="subtitle2">运行方式</Typography>
          <Typography variant="caption" color="text.secondary">
            Nextflow 在该主机上启动，关闭 Phi 后仍会继续运行。
          </Typography>
        </Box>
      )}
      <TextField
        select
        size="small"
        fullWidth
        label="Nextflow 主进程运行位置"
        value={value.controller}
        onChange={(event) =>
          onChange({ ...value, controller: event.target.value as HpcDraft['controller'] })
        }
        helperText={
          value.controller === 'login'
            ? '在登录节点后台常驻；前提是集群允许登录节点运行长时间的轻量进程'
            : '作为 Slurm 作业提交；适合禁止登录节点常驻进程的集群'
        }
      >
        <MenuItem value="login">登录节点（后台常驻）</MenuItem>
        {slurm && <MenuItem value="sbatch">作为 Slurm 作业提交</MenuItem>}
      </TextField>
      {value.controller === 'sbatch' && (
        <TextField
          size="small"
          fullWidth
          label="主进程作业的额外 sbatch 参数"
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
            label="任务调度"
            value={value.scheduler}
            onChange={(event) =>
              onChange({ ...value, scheduler: event.target.value as HpcDraft['scheduler'] })
            }
            helperText={
              slurm ? '每个步骤作为 Slurm 作业提交' : '步骤直接在该主机运行（无调度器的服务器）'
            }
          >
            <MenuItem value="slurm">Slurm 集群</MenuItem>
            <MenuItem value="local">直接在该主机运行</MenuItem>
          </TextField>
          <TextField
            select
            size="small"
            fullWidth
            label="软件环境"
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
              label="队列（partition）"
              value={value.queue}
              onChange={(event) => onChange({ ...value, queue: event.target.value })}
              placeholder="留空用集群默认队列"
            />
            <TextField
              size="small"
              fullWidth
              label="账号（account）"
              value={value.account}
              onChange={(event) => onChange({ ...value, account: event.target.value })}
            />
          </Stack>
          <Stack direction="row" spacing={1.5}>
            <TextField
              size="small"
              fullWidth
              label="额外 sbatch 参数"
              value={value.clusterOptions}
              onChange={(event) => onChange({ ...value, clusterOptions: event.target.value })}
              placeholder="--qos=normal"
              sx={monoInput}
            />
            <TextField
              size="small"
              label="最多同时排队作业数"
              value={value.queueSize}
              onChange={(event) => onChange({ ...value, queueSize: event.target.value })}
              placeholder="不限制"
              sx={{ minWidth: 150 }}
            />
          </Stack>
        </>
      )}
      <TextField
        size="small"
        fullWidth
        label="Singularity 镜像缓存目录"
        value={value.singularityCacheDir}
        onChange={(event) => onChange({ ...value, singularityCacheDir: event.target.value })}
        placeholder="/shared/lab/singularity"
        sx={monoInput}
      />
      <TextField
        size="small"
        fullWidth
        label="Nextflow 路径"
        value={value.nextflowBin}
        onChange={(event) => onChange({ ...value, nextflowBin: event.target.value })}
        placeholder="已在 PATH 中就留空"
        sx={monoInput}
      />
      <TextField
        size="small"
        fullWidth
        multiline
        minRows={2}
        label="启动前执行的命令"
        value={value.setupText}
        onChange={(event) => onChange({ ...value, setupText: event.target.value })}
        placeholder={'module load java\nmodule load nextflow'}
        helperText="每行一条，在启动 Nextflow 前运行"
        sx={monoInput}
      />
    </Stack>
  )
}
