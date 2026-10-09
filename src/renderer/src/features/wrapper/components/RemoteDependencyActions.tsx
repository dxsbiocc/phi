import { Alert, Button, Link, Stack, Typography } from '@mui/material'
import { GoCopy } from 'react-icons/go'

import type { RemoteDoctorReport } from '../../../../../shared/remoteDoctorTypes'

const NEXTFLOW_FALLBACK = 'module load nextflow，或使用 phi-base 环境。'

interface RemoteDependencyActionsProps {
  report: RemoteDoctorReport
  installing: boolean
  onInstallNextflow: () => void
}

interface NextflowActionsProps {
  remediation: string
  showInstall: boolean
  javaReady: boolean
  installing: boolean
  onInstallNextflow: () => void
}

function copySuggestion(suggestion: string): void {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return
  void navigator.clipboard.writeText(suggestion).catch(() => undefined)
}

function NextflowActions({
  remediation,
  showInstall,
  javaReady,
  installing,
  onInstallNextflow
}: NextflowActionsProps): React.JSX.Element {
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      {showInstall && (
        <Button
          size="small"
          variant="outlined"
          disabled={installing || !javaReady}
          onClick={onInstallNextflow}
        >
          {installing ? '正在安装…' : '自动安装 Nextflow'}
        </Button>
      )}
      <Button
        size="small"
        variant="outlined"
        startIcon={<GoCopy aria-hidden="true" />}
        onClick={() => copySuggestion(remediation)}
      >
        复制建议
      </Button>
      <Link
        href="https://docs.seqera.io/nextflow/install"
        target="_blank"
        rel="noopener noreferrer"
        variant="body2"
      >
        手动安装说明
      </Link>
    </Stack>
  )
}

function NextflowRemediation({
  status,
  suggestion,
  javaReady,
  installing,
  onInstallNextflow
}: {
  status: 'warning' | 'error'
  suggestion?: string
  javaReady: boolean
  installing: boolean
  onInstallNextflow: () => void
}): React.JSX.Element {
  const remediation = suggestion?.trim() || NEXTFLOW_FALLBACK
  return (
    <Alert severity={status === 'error' ? 'warning' : 'info'} variant="outlined">
      <Stack spacing={0.75}>
        <Typography variant="body2">
          {status === 'error'
            ? '此运行方式需要 Nextflow。可以安装到服务器账号的个人目录，或按官方文档手动安装。'
            : '登录节点未发现 Nextflow；如果计算节点通过 module 提供，请在运行参数中设置启动命令。'}
        </Typography>
        <Typography component="code" variant="caption" sx={{ userSelect: 'text' }}>
          {remediation}
        </Typography>
        <NextflowActions
          remediation={remediation}
          showInstall={status === 'error'}
          javaReady={javaReady}
          installing={installing}
          onInstallNextflow={onInstallNextflow}
        />
        <Typography variant="caption">
          自动安装需要服务器上已有 Java 17+ 和 curl；不会使用 sudo。手动安装后，可填写“更多运行参数
          → Nextflow 路径”。
        </Typography>
      </Stack>
    </Alert>
  )
}

function DependencyWarnings({
  javaMissing,
  slurmMissing,
  runtimeMissing,
  sftpMissing
}: {
  javaMissing: boolean
  slurmMissing: boolean
  runtimeMissing: boolean
  sftpMissing: boolean
}): React.JSX.Element {
  return (
    <>
      {javaMissing && (
        <Alert severity="warning" variant="outlined">
          请在服务器或计算节点提供 Java 17+，也可在启动命令中加载集群模块；Phi 不会自动修改系统
          Java。
        </Alert>
      )}
      {slurmMissing && (
        <Alert severity="warning" variant="outlined">
          所选 Slurm 运行方式缺少调度命令。请联系集群管理员或在启动命令中加载 Slurm 模块；Phi
          不会安装调度系统。
        </Alert>
      )}
      {runtimeMissing && (
        <Alert severity="warning" variant="outlined">
          所选容器或 Conda 运行时不可用。请手动安装、切换运行时，或在启动命令中加载模块。
        </Alert>
      )}
      {sftpMissing && (
        <Alert severity="warning" variant="outlined">
          本机缺少 SFTP 程序，远程文件传输将不可用；请安装或修复本机 OpenSSH 客户端。
        </Alert>
      )}
    </>
  )
}

/** Run readiness is shown after an explicit Wrapper environment check, never in the SSH host list. */
export function RemoteDependencyActions({
  report,
  installing,
  onInstallNextflow
}: RemoteDependencyActionsProps): React.JSX.Element | null {
  const problem = (id: string): boolean =>
    report.checks.some((check) => check.id === id && check.status !== 'ok')
  const nextflow = report.checks.find((check) => check.id === 'nextflow')
  const javaReady = report.checks.some((check) => check.id === 'java' && check.status === 'ok')
  const slurmMissing = ['slurm_submit', 'slurm_status', 'slurm_detail', 'slurm_cancel'].some((id) =>
    report.checks.some((check) => check.id === id && check.status === 'error')
  )
  const runtimeMissing = report.checks.some(
    (check) => check.id === 'runtime' && check.status === 'error'
  )
  if (
    !problem('nextflow') &&
    !problem('java') &&
    !slurmMissing &&
    !runtimeMissing &&
    !problem('sftp')
  ) {
    return null
  }

  return (
    <Stack spacing={1.25}>
      {nextflow && nextflow.status !== 'ok' && (
        <NextflowRemediation
          status={nextflow.status}
          suggestion={nextflow.suggestion}
          javaReady={javaReady}
          installing={installing}
          onInstallNextflow={onInstallNextflow}
        />
      )}
      <DependencyWarnings
        javaMissing={problem('java')}
        slurmMissing={slurmMissing}
        runtimeMissing={runtimeMissing}
        sftpMissing={problem('sftp')}
      />
    </Stack>
  )
}
