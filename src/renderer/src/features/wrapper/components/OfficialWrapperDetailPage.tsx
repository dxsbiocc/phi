import { Box, Chip } from '@mui/material'
import type { PhiWrapperCatalogDetail } from '../../../../../shared/phiWebsiteCatalogTypes'
import { CatalogDetailFrame } from '../../../components/catalog/CatalogDetailFrame'
import { useUiLanguage } from '../../../lib/i18n'
import {
  officialWrapperDetailGraph,
  officialWrapperDetailManifest
} from '../lib/officialWrapperCatalog'
import { wrapperChoiceIcon, type WrapperCatalogChoice } from '../lib/wrapperCatalog'
import { wrapperCopy } from '../lib/wrapperCopy'
import { parseWrapperCompositionId, wrapperTierLabel } from '../lib/wrapperView'
import { WrapperDetailBody } from './WrapperDetailBody'

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
  const manifest = officialWrapperDetailManifest(detail)
  const graph = officialWrapperDetailGraph(detail)
  // The identity block already shows the tier (Module, Subworkflow…); repeat the website
  // category only when it says something different.
  const tierLabel = wrapperTierLabel(parseWrapperCompositionId(manifest.id).tier)
  const showCategory = Boolean(detail.categoryLabel) && detail.categoryLabel !== tierLabel
  return (
    <CatalogDetailFrame
      entryId={detail.id}
      backLabel={wrapperCopy.backToGroupTools}
      action={action}
      onBack={onBack}
    >
      <Box
        data-phi-official-wrapper-detail={detail.id}
        sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', p: 3 }}
      >
        <Box sx={{ maxWidth: 860, mx: 'auto' }}>
          <WrapperDetailBody
            manifest={manifest}
            icon={wrapperChoiceIcon(choice)}
            graph={graph}
            moduleDetails={undefined}
            extraChips={
              <>
                {showCategory ? (
                  <Chip size="small" variant="outlined" label={detail.categoryLabel} />
                ) : null}
                <Chip size="small" variant="outlined" label={`v${detail.version}`} />
                <Chip size="small" variant="outlined" label={detail.source} />
              </>
            }
          />
        </Box>
      </Box>
    </CatalogDetailFrame>
  )
}
