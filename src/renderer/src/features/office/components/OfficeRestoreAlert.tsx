import { Alert, Button } from '@mui/material'

import type { OfficeDocumentKind } from '../../../../../shared/officeProtocol'
import { officeDocumentCopy } from '../lib/officeDocumentUi'

export type OfficeRestoreStatus =
  | 'recovered'
  | 'source_changed'
  | 'draft_missing'
  | 'draft_corrupt'
  | 'draft_too_large'
  | 'draft_hash_mismatch'
  | 'operation_log_corrupt'
  | 'stale_process_unverified'

export interface OfficeRestoreAlertProps {
  status: OfficeRestoreStatus
  kind?: OfficeDocumentKind
  hasUnsavedChanges?: boolean
  sourceAvailable?: boolean
  onRecreateFromSource?: () => void
}

type IntegrityStatus =
  | 'draft_missing'
  | 'draft_corrupt'
  | 'draft_too_large'
  | 'draft_hash_mismatch'
  | 'operation_log_corrupt'

const INTEGRITY_MESSAGES: Record<Exclude<IntegrityStatus, 'draft_corrupt'>, string> = {
  draft_missing: '草稿文件已丢失',
  draft_too_large: 'Office 草稿超过 25 MB 上限',
  draft_hash_mismatch: '草稿文件与最后一次确认保存的内容不一致，需要核对；写入与交付已冻结',
  operation_log_corrupt: '草稿写入记录已损坏，文档已冻结等待核对'
}

function integrityMessage(status: IntegrityStatus, kind: OfficeDocumentKind): string {
  return status === 'draft_corrupt'
    ? `草稿文件已损坏，无法作为有效 ${officeDocumentCopy(kind).formatName} 打开`
    : INTEGRITY_MESSAGES[status]
}

function IntegrityAlert({
  status,
  kind,
  sourceAvailable,
  onRecreateFromSource
}: {
  status: IntegrityStatus
  kind: OfficeDocumentKind
  sourceAvailable: boolean
  onRecreateFromSource?: () => void
}): React.JSX.Element {
  const action =
    sourceAvailable && onRecreateFromSource ? (
      <Button
        color="inherit"
        size="small"
        data-phi-office-restore-fresh="true"
        onClick={onRecreateFromSource}
      >
        从原文件重新创建草稿
      </Button>
    ) : undefined
  return (
    <Alert
      data-phi-office-restore-alert={status}
      data-phi-office-restore-error={status}
      severity="error"
      action={action}
      sx={{ borderRadius: 0 }}
    >
      {integrityMessage(status, kind)}
    </Alert>
  )
}

function SourceChangedAlert(): React.JSX.Element {
  return (
    <Alert
      data-phi-office-restore-alert="source_changed"
      data-phi-office-restore-source-changed="true"
      severity="info"
      icon={false}
      sx={{ borderRadius: 0 }}
    >
      源文件已变化，已基于最新源文件创建新草稿；旧草稿仍保留
    </Alert>
  )
}

function StaleProcessAlert(): React.JSX.Element {
  return (
    <Alert
      data-phi-office-restore-alert="stale_process_unverified"
      data-phi-office-restore-stale-process="unverified"
      severity="error"
      sx={{ borderRadius: 0 }}
    >
      检测到可能属于该草稿的残留进程，但无法确认。请退出残留进程后重试
    </Alert>
  )
}

function RecoveredAlert({ hasUnsavedChanges }: { hasUnsavedChanges: boolean }): React.JSX.Element {
  return (
    <Alert
      data-phi-office-restore-alert="recovered"
      data-phi-office-restore-recovered="true"
      severity="info"
      icon={false}
      sx={{ borderRadius: 0 }}
    >
      {hasUnsavedChanges ? '已恢复本会话草稿（含未另存的修改），原文件未改动' : '已恢复本会话草稿'}
    </Alert>
  )
}

export function OfficeRestoreAlert({
  status,
  kind = 'xlsx',
  hasUnsavedChanges = false,
  sourceAvailable = false,
  onRecreateFromSource
}: OfficeRestoreAlertProps): React.JSX.Element {
  if (
    status === 'draft_missing' ||
    status === 'draft_corrupt' ||
    status === 'draft_too_large' ||
    status === 'draft_hash_mismatch' ||
    status === 'operation_log_corrupt'
  ) {
    return <IntegrityAlert {...{ status, kind, sourceAvailable, onRecreateFromSource }} />
  }
  if (status === 'stale_process_unverified') return <StaleProcessAlert />
  if (status === 'source_changed') return <SourceChangedAlert />
  return <RecoveredAlert hasUnsavedChanges={hasUnsavedChanges} />
}
