import { Box } from '@mui/material'
import type { PhiWrapperCatalogDetail } from '../../../../../shared/phiWebsiteCatalogTypes'
import { CatalogDetailFrame } from '../../../components/catalog/CatalogDetailFrame'
import { useUiLanguage } from '../../../lib/i18n'
import type { WrapperCatalogChoice } from '../lib/wrapperCatalog'
import { wrapperCopy } from '../lib/wrapperCopy'
import { OfficialWrapperDetailContent } from './OfficialWrapperDetailContent'

export function OfficialWrapperDetailPage({
  detail,
  choice,
  action,
  onBack
}: {
  detail: PhiWrapperCatalogDetail
  choice: WrapperCatalogChoice
  action: React.ReactNode
  onBack: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <CatalogDetailFrame
      entryId={detail.id}
      backLabel={wrapperCopy.backToGroupTools}
      action={action}
      onBack={onBack}
    >
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
        <OfficialWrapperDetailContent detail={detail} choice={choice} />
      </Box>
    </CatalogDetailFrame>
  )
}
