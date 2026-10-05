import { Alert, Box, CircularProgress, Typography } from '@mui/material'

import { OfficeRestoreAlert, type OfficeRestoreStatus } from './components/OfficeRestoreAlert'
import { OfficeReadyDocument } from './components/OfficeReadyDocument'
import { useOfficeDocument } from './hooks/useOfficeDocument'
import { useOfficeReconciliation } from './hooks/useOfficeReconciliation'
import { useOfficeHumanEditFeedback } from './hooks/useOfficeHumanEditFeedback'
import { useOfficeSave } from './hooks/useOfficeSave'
import { useOfficeSaveAs } from './hooks/useOfficeSaveAs'
import { useOfficeFollowAi } from './hooks/useOfficeFollowAi'
import { useOfficeExport } from './hooks/useOfficeExport'
import { officeDocumentKindForPath } from '../../lib/officeDocumentPath'
import { officePanelErrorMessage } from './lib/officeDocumentUi'

export interface OfficePanelProps {
  sourcePath: string
}

const RESTORE_ERROR_CODES = new Set<OfficeRestoreStatus>([
  'draft_missing',
  'draft_corrupt',
  'draft_too_large',
  'stale_process_unverified'
])

function OfficeErrorPanel({
  sourcePath,
  code,
  message,
  canRecreate,
  freshSourcePath,
  onRecreate
}: {
  sourcePath: string
  code: string
  message: string
  canRecreate: boolean
  freshSourcePath?: string
  onRecreate: (freshSourcePath?: string) => void
}): React.JSX.Element {
  if (RESTORE_ERROR_CODES.has(code as OfficeRestoreStatus)) {
    return (
      <Box data-phi-office-state="error" sx={{ p: 2 }}>
        <OfficeRestoreAlert
          status={code as OfficeRestoreStatus}
          kind={officeDocumentKindForPath(sourcePath) ?? 'xlsx'}
          sourceAvailable={canRecreate}
          onRecreateFromSource={() => onRecreate(freshSourcePath)}
        />
      </Box>
    )
  }
  return (
    <Box data-phi-office-state="error" data-phi-office-source={sourcePath} sx={{ p: 2 }}>
      <Alert severity="error" variant="outlined">
        {officePanelErrorMessage(code, message)}
      </Alert>
    </Box>
  )
}

export function OfficePanel({ sourcePath }: OfficePanelProps): React.JSX.Element {
  const { status, publishStatus, recreateFromSource } = useOfficeDocument(sourcePath)
  const reconciliation = useOfficeReconciliation(
    status.state === 'ready' ? status.document : null,
    publishStatus
  )
  const humanEdit = useOfficeHumanEditFeedback(
    status.state === 'ready' ? status.document.lastHumanEdit : undefined
  )
  const save = useOfficeSave(status.state === 'ready' ? status.document : null, publishStatus)
  const saveAs = useOfficeSaveAs(status.state === 'ready' ? status.document : null)
  const followAi = useOfficeFollowAi(status.state === 'ready' ? status.document : null)
  const exportState = useOfficeExport(status.state === 'ready' ? status.document : null, sourcePath)

  if (status.state === 'preparing') {
    return (
      <Box
        data-phi-office-state="preparing"
        sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}
      >
        <CircularProgress size={18} />
        <Typography variant="body2">正在准备 Office 运行环境…</Typography>
      </Box>
    )
  }

  if (status.state === 'error') {
    return (
      <OfficeErrorPanel
        sourcePath={sourcePath}
        code={status.code}
        message={status.message}
        canRecreate={status.canRecreateFromSource === true}
        freshSourcePath={status.freshSourcePath}
        onRecreate={recreateFromSource}
      />
    )
  }

  return (
    <OfficeReadyDocument
      document={status.document}
      save={save}
      saveAs={saveAs}
      reconciliation={reconciliation}
      humanEdit={humanEdit}
      followAi={followAi}
      export={exportState}
      recreateFromSource={recreateFromSource}
    />
  )
}
