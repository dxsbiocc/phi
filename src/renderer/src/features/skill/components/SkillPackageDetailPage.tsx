import { useUiLanguage } from '../../../lib/i18n'
import { skillCopy } from '../lib/skillCopy'
import { resourceUi, resourceSourceLabel } from '../../../lib/resourceUi'
import { Chip } from '@mui/material'

import { CatalogDetailFrame } from '../../../components/catalog/CatalogDetailFrame'
import { useSkillPackageMarkdown } from '../hooks/useSkillPackageMarkdown'
import { formatPackageSize } from '../../../components/catalog/packageSize'
import type { SkillCatalogPackage } from '../lib/skillCatalogBrowser'
import { SkillDetailBody } from './SkillDetailBody'

/** Catalog preview of one skill package, drawn by the same body as the installed skill page. */
export function SkillPackageDetailPage({
  entry,
  installed,
  action,
  onBack
}: {
  entry: SkillCatalogPackage
  installed: boolean
  /** The install / update / uninstall controls, shared with the catalog table. */
  action: React.ReactNode
  onBack: () => void
}): React.JSX.Element {
  useUiLanguage()

  const markdown = useSkillPackageMarkdown(entry.registryDir, entry.id)
  const origin = resourceSourceLabel(entry.registryLabel ?? skillCopy.packagesGroup)
  return (
    <CatalogDetailFrame
      entryId={entry.id}
      backLabel={skillCopy.backToCatalog}
      action={action}
      onBack={onBack}
    >
      <SkillDetailBody
        name={entry.title}
        icon={entry.icon}
        enabled
        sourceLabel={`${skillCopy.packageSource} · ${origin}`}
        chips={
          <>
            <Chip size="small" variant="outlined" label={origin} />
            <Chip size="small" variant="outlined" label={`v${entry.version}`} />
            <Chip size="small" variant="outlined" label={formatPackageSize(entry.size)} />
            <Chip
              size="small"
              color={installed ? 'success' : 'default'}
              label={installed ? resourceUi.installed : skillCopy.notInstalled}
            />
          </>
        }
        description={entry.summary}
        sourceText={`${skillCopy.packageSource} · ${origin} · v${entry.version}`}
        markdown={markdown}
      />
    </CatalogDetailFrame>
  )
}
