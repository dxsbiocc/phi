import { useState } from 'react'
import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material'

import type { WrapperCompositionCatalogItem } from '../../../../../shared/wrapperCompositionManifestTypes'
import { ResourceIcon } from '../../../components/ResourceIcon'
import { PhiIcons } from '../../../icons'
import { useWrapperPackageMembers } from '../hooks/useWrapperPackageMembers'
import type { WrapperCatalogChoice } from '../lib/wrapperCatalog'
import { useWrapperDetailData } from '../hooks/useWrapperDetailData'
import { WrapperDetailBody } from './WrapperDetailBody'
import { WrapperPackageRail } from './WrapperPackageRail'

export interface WrapperPackageDetailPageProps {
  choice: WrapperCatalogChoice
  catalog: readonly WrapperCompositionCatalogItem[]
  /** The install / add / enable control, shared with the catalog table. */
  action: React.ReactNode
  onBack: () => void
}

/**
 * Catalog preview of one package. It reuses the tool list and wrapper contract of the
 * wrapper page, fed from the local catalog or, for an uninstalled package, its archive.
 */
export function WrapperPackageDetailPage({
  choice,
  catalog,
  action,
  onBack
}: WrapperPackageDetailPageProps): React.JSX.Element {
  const members = useWrapperPackageMembers(catalog, choice)
  const [pickedId, setPickedId] = useState<string | null>(null)
  const selected = members.wrappers.find((entry) => entry.id === pickedId) ?? members.wrappers[0]
  const detailData = useWrapperDetailData(
    selected,
    members.bundled ? { dag: selected?.dag, details: selected?.details } : undefined
  )

  return (
    <Box
      data-phi-wrapper-package-detail={choice.id}
      sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', px: 3, py: 2 }}>
        <Button
          size="small"
          aria-label="返回 wrapper 目录"
          onClick={onBack}
          startIcon={<PhiIcons.action.back size={16} sx={{ transform: 'rotate(180deg)' }} />}
        >
          返回
        </Button>
        <ResourceIcon
          icon={choice.cached?.icon ?? choice.registryEntry?.icon}
          kind="wrapper"
          sx={{ color: 'primary.main' }}
        />
        <Typography variant="h6" noWrap sx={{ flex: 1, minWidth: 0 }} title={choice.title}>
          {choice.title}
        </Typography>
        <Chip size="small" label={choice.category} />
        {choice.version ? (
          <Chip size="small" variant="outlined" label={`v${choice.version}`} />
        ) : null}
        {action}
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', borderTop: 1, borderColor: 'divider' }}>
        {members.wrappers.length > 1 ? (
          <WrapperPackageRail
            familyName={choice.title}
            members={members.wrappers}
            selectedId={selected?.id ?? null}
            onSelect={(entry) => setPickedId(entry.id)}
            showHeading={false}
          />
        ) : null}
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', p: 3 }}>
          {members.status === 'loading' ? (
            <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }}>
              <CircularProgress size={22} />
            </Box>
          ) : members.status === 'error' ? (
            <Alert severity="error">{members.error}</Alert>
          ) : selected ? (
            <Box sx={{ maxWidth: 860, mx: 'auto' }}>
              {members.skipped > 0 ? (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  有 {members.skipped} 个 wrapper 的清单无法解析，已跳过。
                </Alert>
              ) : null}
              <WrapperDetailBody
                manifest={selected}
                icon={choice.cached?.icon}
                graph={detailData.graph}
                moduleDetails={detailData.moduleDetails}
              />
            </Box>
          ) : (
            <Typography color="text.secondary">这个软件包里没有可显示的 wrapper。</Typography>
          )}
        </Box>
      </Box>
    </Box>
  )
}
