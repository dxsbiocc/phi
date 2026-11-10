import { Box, Chip } from '@mui/material'
import type { PhiWrapperCatalogDetail } from '../../../../../shared/phiWebsiteCatalogTypes'
import { useUiLanguage } from '../../../lib/i18n'
import { websiteSourceLabel } from '../../../lib/resourceUi'
import {
  officialWrapperDetailGraph,
  officialWrapperDetailManifest
} from '../lib/officialWrapperCatalog'
import { wrapperChoiceIcon, type WrapperCatalogChoice } from '../lib/wrapperCatalog'
import { parseWrapperCompositionId, wrapperTierLabel } from '../lib/wrapperView'
import { WrapperDetailBody } from './WrapperDetailBody'

/** The official Wrapper detail body without the page shell, shared by the page and suite split view. */
export function OfficialWrapperDetailContent({
  detail,
  choice,
  headerAction
}: {
  detail: PhiWrapperCatalogDetail
  choice: WrapperCatalogChoice
  /** Controls at the right end of the identity row, e.g. install / uninstall. */
  headerAction?: React.ReactNode
}): React.JSX.Element {
  useUiLanguage()
  const manifest = officialWrapperDetailManifest(detail)
  const graph = officialWrapperDetailGraph(detail)
  // The identity block already shows the tier (Module, Subworkflow…); repeat the website
  // category only when it says something different.
  const tierLabel = wrapperTierLabel(parseWrapperCompositionId(manifest.id).tier)
  const showCategory = Boolean(detail.categoryLabel) && detail.categoryLabel !== tierLabel
  return (
    <Box data-phi-official-wrapper-detail={detail.id} sx={{ minWidth: 0, p: 3 }}>
      <Box sx={{ maxWidth: 860, mx: 'auto' }}>
        <WrapperDetailBody
          manifest={manifest}
          icon={wrapperChoiceIcon(choice)}
          graph={graph}
          moduleDetails={undefined}
          headerAction={headerAction}
          extraChips={
            <>
              {showCategory ? (
                <Chip size="small" variant="outlined" label={detail.categoryLabel} />
              ) : null}
              <Chip size="small" variant="outlined" label={`v${detail.version}`} />
              <Chip size="small" variant="outlined" label={websiteSourceLabel(detail.source)} />
            </>
          }
        />
      </Box>
    </Box>
  )
}
