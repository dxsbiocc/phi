import { Chip } from '@mui/material'

import type { PhiSkillCatalogDetail } from '../../../../../shared/phiWebsiteCatalogTypes'
import { CatalogDetailFrame } from '../../../components/catalog/CatalogDetailFrame'
import { formatPackageSize } from '../../../components/catalog/packageSize'
import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi, websiteSourceLabel } from '../../../lib/resourceUi'
import { skillCopy } from '../lib/skillCopy'
import { SkillDetailBody } from './SkillDetailBody'

/** Structured Phi Website detail, rendered by the same safe body as installed skills. */
export function OfficialSkillDetailPage({
  detail,
  installed,
  action,
  onBack
}: {
  detail: PhiSkillCatalogDetail
  installed: boolean
  action: React.ReactNode
  onBack: () => void
}): React.JSX.Element {
  useUiLanguage()

  const size = detail.sizeLabel ?? formatPackageSize(detail.sizeBytes ?? 0)
  const source = websiteSourceLabel(detail.source)
  return (
    <CatalogDetailFrame
      entryId={detail.slug}
      backLabel={skillCopy.backToCatalog}
      action={action}
      onBack={onBack}
    >
      <SkillDetailBody
        name={detail.title}
        enabled
        sourceLabel={source}
        chips={
          <>
            <Chip size="small" variant="outlined" label={source} />
            <Chip size="small" variant="outlined" label={`v${detail.version}`} />
            <Chip size="small" variant="outlined" label={size} />
            <Chip
              size="small"
              color={installed ? 'success' : 'default'}
              label={installed ? resourceUi.installed : skillCopy.notInstalled}
            />
          </>
        }
        description={detail.description ?? ''}
        sourceText={`${source} · v${detail.version}`}
        markdown={{ content: detail.markdown, isLoading: false, error: null }}
      />
    </CatalogDetailFrame>
  )
}
