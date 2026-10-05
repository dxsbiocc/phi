import { Alert, Button, CircularProgress } from '@mui/material'

import type { OfficeReconcileUiState } from '../lib/officeReconcileController'
import type { OfficeHumanEditSummary } from '../../../../../shared/officeProtocol'

export interface OfficeDocumentAlertProps {
  freezeState?: 'unknown'
  needsSave: boolean
  reconcileState: OfficeReconcileUiState
  onReconcile: () => void
  humanEdit?: OfficeHumanEditSummary
  onDismissHumanEdit?: () => void
}

function ReconcileResultAlert({
  state
}: {
  state: OfficeReconcileUiState
}): React.JSX.Element | null {
  if (state.phase !== 'result' && state.phase !== 'error') return null
  const conclusion = state.phase === 'result' ? state.conclusion : 'error'
  const severity =
    state.phase === 'error' ? 'error' : state.conclusion === 'indeterminate' ? 'warning' : 'success'
  return (
    <Alert
      data-phi-office-reconcile-result={conclusion}
      severity={severity}
      icon={false}
      sx={{ borderRadius: 0 }}
    >
      {state.message}
    </Alert>
  )
}

export function OfficeDocumentAlert({
  freezeState,
  needsSave,
  reconcileState,
  onReconcile,
  humanEdit,
  onDismissHumanEdit
}: OfficeDocumentAlertProps): React.JSX.Element | null {
  const showsResult = reconcileState.phase === 'result' || reconcileState.phase === 'error'
  const showsHumanFailure = humanEdit?.conclusion === 'failed'
  if (freezeState !== 'unknown' && !needsSave && !showsResult && !showsHumanFailure) return null
  const pending = reconcileState.phase === 'pending'
  return (
    <>
      {freezeState === 'unknown' && (
        <Alert
          data-phi-office-freeze-banner="true"
          severity="warning"
          action={
            <Button
              color="inherit"
              size="small"
              disabled={pending}
              startIcon={pending ? <CircularProgress color="inherit" size={12} /> : undefined}
              onClick={onReconcile}
            >
              {pending ? '核对中…' : '重新核对'}
            </Button>
          }
          sx={{ borderRadius: 0 }}
        >
          写入结果待核对
        </Alert>
      )}
      {needsSave && (
        <Alert
          data-phi-office-save-banner="true"
          severity="warning"
          icon={false}
          sx={{ borderRadius: 0 }}
        >
          草稿尚未保存
        </Alert>
      )}
      {showsHumanFailure && humanEdit && (
        <Alert
          data-phi-office-human-edit-failure={humanEdit.code}
          severity="error"
          onClose={onDismissHumanEdit}
          sx={{ borderRadius: 0 }}
        >
          {humanEdit.message}
        </Alert>
      )}
      <ReconcileResultAlert state={reconcileState} />
    </>
  )
}
