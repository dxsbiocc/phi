import { Box, CircularProgress, IconButton, Stack, Typography } from '@mui/material'
import type { PhiWrapperCatalogDetail } from '../../../../../shared/phiWebsiteCatalogTypes'
import { CatalogDetailFrame } from '../../../components/catalog/CatalogDetailFrame'
import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import type { OfficialWrapperToolChoice } from '../lib/officialWrapperCatalog'
import { wrapperCopy } from '../lib/wrapperCopy'
import { OfficialWrapperDetailContent } from './OfficialWrapperDetailContent'
import { OfficialWrapperToolList } from './OfficialWrapperToolList'

function DetailLoading(): React.JSX.Element {
  return (
    <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}>
      <CircularProgress size={22} />
    </Box>
  )
}

/**
 * A suite's tools stay visible in a fixed rail while the selected tool's full official Wrapper
 * detail renders beside it. Below 900px the rail stacks above the detail.
 */
export function OfficialWrapperSuiteSplitView({
  suite,
  choices,
  selectedToolId,
  detail,
  query,
  loading,
  detailLoading,
  busy,
  feedback,
  renderAction,
  onQueryChange,
  onSelect,
  onBack,
  onClose
}: {
  suite: string
  choices: readonly OfficialWrapperToolChoice[]
  selectedToolId?: string
  detail?: PhiWrapperCatalogDetail
  query: string
  loading: boolean
  detailLoading: boolean
  busy: boolean
  feedback?: React.ReactNode
  renderAction: (choice: OfficialWrapperToolChoice['choice']) => React.ReactNode
  onQueryChange: (value: string) => void
  onSelect: (id: string) => void
  onBack: () => void
  onClose: () => void
}): React.JSX.Element {
  useUiLanguage()
  const selected = choices.find(({ tool }) => tool.id === selectedToolId)
  const selectedDetail = detail?.id === selectedToolId ? detail : undefined

  return (
    <CatalogDetailFrame
      entryId={`group:${suite}`}
      backLabel={wrapperCopy.backToWrapperGroups}
      onBack={onBack}
      action={
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {selected ? renderAction(selected.choice) : null}
          <IconButton aria-label={wrapperCopy.closeCatalog} disabled={busy} onClick={onClose}>
            <PhiIcons.action.close size={20} />
          </IconButton>
        </Stack>
      }
    >
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Stack direction="row" sx={{ alignItems: 'baseline', px: 3, pt: 2.5, pb: 2 }} spacing={1}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {suite}
          </Typography>
          {loading ? null : (
            <Typography variant="body2" color="text.secondary">
              {wrapperCopy.toolCount(choices.length)}
            </Typography>
          )}
        </Stack>
        {feedback ? <Box sx={{ px: 3, pb: 2 }}>{feedback}</Box> : null}
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            borderTop: 1,
            borderColor: 'divider'
          }}
        >
          <Box
            sx={{
              width: { xs: '100%', md: 260 },
              flex: { xs: '0 0 auto', md: '0 0 260px' },
              maxHeight: { xs: '44%', md: 'none' },
              minHeight: 0,
              p: 1.5,
              display: 'flex',
              flexDirection: 'column',
              borderRight: { xs: 0, md: 1 },
              borderBottom: { xs: 1, md: 0 },
              borderColor: 'divider'
            }}
          >
            <OfficialWrapperToolList
              suite={suite}
              choices={choices}
              selectedId={selectedToolId}
              query={query}
              loading={loading}
              onQueryChange={onQueryChange}
              onSelect={onSelect}
            />
          </Box>
          <Box
            data-phi-official-wrapper-suite-detail={selectedToolId ?? ''}
            sx={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}
          >
            {selected && selectedDetail ? (
              <OfficialWrapperDetailContent detail={selectedDetail} choice={selected.choice} />
            ) : detailLoading || (selectedToolId && !selectedDetail) ? (
              <DetailLoading />
            ) : (
              <Typography color="text.secondary" sx={{ p: 3 }}>
                {wrapperCopy.noSuiteTools}
              </Typography>
            )}
          </Box>
        </Box>
      </Box>
    </CatalogDetailFrame>
  )
}
