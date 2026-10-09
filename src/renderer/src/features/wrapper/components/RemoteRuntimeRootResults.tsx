import { Alert, Box, Button, Stack, Typography } from '@mui/material'
import { GoAlert, GoCheckCircle, GoInfo, GoXCircle } from 'react-icons/go'

import type { RemoteRuntimeRootCheckResult } from '../../../../../shared/remoteRuntimeRootTypes'
import {
  formatRemoteRuntimeRootSpace,
  type RemoteRuntimeRootUiStatus
} from '../lib/remoteRuntimeRootUi'

type RowTone = 'ok' | 'warning' | 'error' | 'info'
type BooleanPresentation = { tone: RowTone; text: string }

function ResultIcon({ tone }: { tone: RowTone }): React.JSX.Element {
  if (tone === 'ok') return <GoCheckCircle color="var(--mui-palette-success-main)" />
  if (tone === 'warning') return <GoAlert color="var(--mui-palette-warning-main)" />
  if (tone === 'error') return <GoXCircle color="var(--mui-palette-error-main)" />
  return <GoInfo color="var(--mui-palette-info-main)" />
}

function ResultRow({ tone, text }: { tone: RowTone; text: string }): React.JSX.Element {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
      <Box sx={{ display: 'flex', mt: '2px' }}>
        <ResultIcon tone={tone} />
      </Box>
      <Typography variant="caption">{text}</Typography>
    </Stack>
  )
}

function existenceText(result: RemoteRuntimeRootCheckResult): string {
  if (result.exists) return '目录已存在'
  if (result.ancestorWritable && result.nearestExistingAncestor) {
    return `尚未创建，可在 ${result.nearestExistingAncestor} 下创建`
  }
  return '目录不存在，且无法在最近的已有祖先目录中创建'
}

function booleanPresentation(
  value: boolean | null,
  positive: string,
  negative: string,
  unknown: string,
  positiveTone: RowTone = 'ok',
  negativeTone: RowTone = 'warning'
): BooleanPresentation {
  if (value === null) return { tone: 'info', text: unknown }
  return value ? { tone: positiveTone, text: positive } : { tone: negativeTone, text: negative }
}

function PathRows({ result }: { result: RemoteRuntimeRootCheckResult }): React.JSX.Element {
  return (
    <>
      <ResultRow
        tone={result.expandedPath ? 'ok' : 'error'}
        text={`路径解析：${result.expandedPath ?? '无法解析'}`}
      />
      <ResultRow
        tone={result.exists || result.ancestorWritable ? 'ok' : 'error'}
        text={existenceText(result)}
      />
    </>
  )
}

function SafetyRows({ result }: { result: RemoteRuntimeRootCheckResult }): React.JSX.Element {
  const owner = booleanPresentation(
    result.ownedByCurrentUser,
    '归当前用户所有',
    '不归当前用户所有',
    '所有者：未知'
  )
  const writable = booleanPresentation(
    result.groupOrOtherWritable,
    '组或其他用户可写',
    '组或其他用户不可写',
    '组或其他用户写权限：未知',
    'warning',
    'ok'
  )
  const symlink = booleanPresentation(
    result.hasSymlink,
    '路径中包含符号链接',
    '路径中不包含符号链接',
    '符号链接：未知',
    'warning',
    'ok'
  )
  return (
    <>
      <ResultRow {...owner} />
      <ResultRow {...writable} />
      <ResultRow {...symlink} />
    </>
  )
}

function StorageRows({ result }: { result: RemoteRuntimeRootCheckResult }): React.JSX.Element {
  const space = formatRemoteRuntimeRootSpace(result.availableKiB)
  const spaceWarning = result.warnings.some(
    ({ code }) => code === 'low-space' || code === 'high-disk-use'
  )
  const executable = booleanPresentation(
    result.executable,
    '可以执行探针脚本',
    '不可执行',
    '可执行：未知'
  )
  return (
    <>
      <ResultRow tone="info" text={`文件系统：${result.fsType ?? '未知'}`} />
      <ResultRow
        tone={spaceWarning ? 'warning' : result.availableKiB === null ? 'info' : 'ok'}
        text={`剩余空间：${space}${result.diskUsePercent === null ? '' : `（已用 ${result.diskUsePercent}%）`}`}
      />
      <ResultRow {...executable} />
      <ResultRow
        tone={result.sharedFilesystem ? 'info' : 'ok'}
        text={
          result.sharedFilesystem
            ? '共享盘；计算节点可见性未知'
            : result.sharedFilesystem === false
              ? '非共享盘'
              : '是否为共享盘：未知'
        }
      />
    </>
  )
}

function CheckedRows({ result }: { result: RemoteRuntimeRootCheckResult }): React.JSX.Element {
  return (
    <Stack spacing={0.5}>
      <PathRows result={result} />
      <SafetyRows result={result} />
      <StorageRows result={result} />
    </Stack>
  )
}

function IssueAlerts({ result }: { result: RemoteRuntimeRootCheckResult }): React.JSX.Element {
  return (
    <Stack spacing={0.75}>
      {result.hardErrors.map((issue) => (
        <Alert key={issue.code} severity="error">
          {issue.message} 请改为绝对路径或 ~/…，并确保最近的已有祖先目录可写。
        </Alert>
      ))}
      {result.warnings.map((warning) => (
        <Alert key={warning.code} severity="warning">
          {warning.message} 后果：{warning.consequence}
        </Alert>
      ))}
    </Stack>
  )
}

export function RemoteRuntimeRootResults({
  status,
  onConfirmWarnings
}: {
  status: RemoteRuntimeRootUiStatus
  onConfirmWarnings?: () => void
}): React.JSX.Element {
  if (status.phase === 'idle') return <ResultRow tone="info" text="未检测" />
  if (status.phase === 'running') return <ResultRow tone="info" text="正在检测…" />
  if (status.phase === 'timed-out') return <ResultRow tone="warning" text="检测超时" />
  if (status.phase === 'failed') return <ResultRow tone="error" text="检测未完成" />
  const { result } = status
  return (
    <Stack spacing={1}>
      <CheckedRows result={result} />
      <IssueAlerts result={result} />
      {result.warnings.length > 0 && result.hardErrors.length === 0 && onConfirmWarnings && (
        <Button size="small" color="warning" variant="outlined" onClick={onConfirmWarnings}>
          仍然使用
        </Button>
      )}
    </Stack>
  )
}
