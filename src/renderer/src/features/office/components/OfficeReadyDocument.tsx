import { Alert, Box, Typography } from '@mui/material'

import type { OfficePreviewDocument } from '../../../../../shared/officeProtocol'
import type { OfficeHumanEditSummary } from '../../../../../shared/officeProtocol'
import type { OfficeReconciliationHookState } from '../hooks/useOfficeReconciliation'
import type { OfficeSaveHookState } from '../hooks/useOfficeSave'
import type { OfficeSaveAsHookState } from '../hooks/useOfficeSaveAs'
import { OfficeDocumentAlert } from './OfficeDocumentAlert'
import { OfficeRestoreAlert } from './OfficeRestoreAlert'
import { OfficeSaveToolbar } from './OfficeSaveToolbar'
import { OfficeFollowToggle } from './OfficeFollowToggle'
import type { OfficeFollowAiState } from '../hooks/useOfficeFollowAi'
import type { OfficeExportHookState } from '../hooks/useOfficeExport'
import { OfficeExportMenu } from './OfficeExportMenu'
import {
  officeDocumentCopy,
  officeDocumentHumanEdit,
  officeDocumentKind
} from '../lib/officeDocumentUi'

interface OfficeReadyDocumentProps {
  readonly document: OfficePreviewDocument
  readonly save: OfficeSaveHookState
  readonly saveAs: OfficeSaveAsHookState
  readonly reconciliation: OfficeReconciliationHookState
  readonly humanEdit: { readonly failure?: OfficeHumanEditSummary; readonly dismiss: () => void }
  readonly followAi?: OfficeFollowAiState
  readonly export?: OfficeExportHookState
  readonly recreateFromSource: (sourcePath?: string) => void
}

const OfficeWebview: React.ElementType = 'webview'

function RestoreNotice({
  document,
  recreateFromSource
}: Pick<OfficeReadyDocumentProps, 'document' | 'recreateFromSource'>): React.JSX.Element | null {
  const notice = document.restoreNotice
  if (!notice) return null
  return (
    <OfficeRestoreAlert
      status={notice.kind}
      kind={officeDocumentKind(document)}
      hasUnsavedChanges={notice.kind === 'recovered' ? notice.hasUnsavedChanges : false}
      sourceAvailable={document.sourceHash !== null}
      onRecreateFromSource={() => recreateFromSource(document.sourcePath)}
    />
  )
}

function EditingHint({ document }: { document: OfficePreviewDocument }): React.JSX.Element {
  const copy = officeDocumentCopy(officeDocumentKind(document))
  const message =
    officeDocumentHumanEdit(document) === 'none'
      ? '只读实时预览'
      : document.readOnly || document.freezeState === 'unknown'
        ? '当前文档暂不可编辑'
        : '双击单元格可编辑'
  return (
    <Alert severity="info" icon={false} sx={{ borderRadius: 0, py: 0.5 }}>
      {message}；显示效果可能与 Microsoft {copy.productName} 略有差异。
    </Alert>
  )
}

function PreviewContent({ document }: { document: OfficePreviewDocument }): React.JSX.Element {
  if (document.previewState === 'preview_failed') {
    return (
      <Alert
        severity="error"
        data-phi-office-preview-failed="true"
        sx={{ m: 2, alignSelf: 'stretch' }}
      >
        {document.previewError ?? '预览渲染失败：无法显示文档页面'}
      </Alert>
    )
  }
  const emptyPresentation = officeDocumentKind(document) === 'pptx' && document.slideCount === 0
  return (
    <Box sx={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
      <OfficeWebview
        src={document.previewUrl}
        partition="phi-office-preview"
        webpreferences="sandbox=yes,contextIsolation=yes,nodeIntegration=no"
        aria-hidden={emptyPresentation || undefined}
        data-phi-office-webview="true"
        style={
          emptyPresentation
            ? { position: 'absolute', inset: 0, visibility: 'hidden', pointerEvents: 'none' }
            : { display: 'flex', flex: 1, minHeight: 0 }
        }
      />
      {emptyPresentation ? (
        <Box
          data-phi-office-empty-preview="pptx"
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Typography color="text.secondary" variant="body2">
            暂无幻灯片
          </Typography>
        </Box>
      ) : null}
    </Box>
  )
}

export function OfficeReadyDocument({
  document,
  save,
  saveAs,
  reconciliation,
  humanEdit,
  followAi,
  export: exportState,
  recreateFromSource
}: OfficeReadyDocumentProps): React.JSX.Element {
  return (
    <Box
      data-phi-office-state="ready"
      data-phi-office-artifact={document.artifactId}
      sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <OfficeSaveToolbar
        document={document}
        state={save.state}
        saveAsState={saveAs.state}
        onSave={() => void save.save()}
        onSaveAs={() => void saveAs.saveAs()}
        onRevealOutput={() => void saveAs.revealOutput()}
      />
      {exportState ? (
        <OfficeExportMenu
          available={exportState.available}
          document={document}
          activeSheet={exportState.activeSheet}
          state={exportState.state}
          onExport={(format) => void exportState.exportSheet(format)}
          onCancel={() => void exportState.cancel()}
          onRevealOutput={() => void exportState.revealOutput()}
        />
      ) : null}
      {officeDocumentKind(document) === 'xlsx' && followAi?.controllable ? (
        <OfficeFollowToggle enabled={followAi.enabled} onChange={followAi.setEnabled} />
      ) : null}
      <RestoreNotice document={document} recreateFromSource={recreateFromSource} />
      <OfficeDocumentAlert
        freezeState={document.freezeState}
        needsSave={document.needsSave === true}
        reconcileState={reconciliation.state}
        humanEdit={officeDocumentHumanEdit(document) === 'cells' ? humanEdit.failure : undefined}
        onDismissHumanEdit={humanEdit.dismiss}
        onReconcile={() => void reconciliation.reconcile()}
      />
      <EditingHint document={document} />
      <PreviewContent document={document} />
    </Box>
  )
}
