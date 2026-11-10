import { Box, CircularProgress, Divider, IconButton, Typography } from '@mui/material'
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
 * detail renders beside it. The group action installs/updates/removes the whole suite. Below
 * 900px the rail stacks above the detail.
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
  renderSuiteAction,
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
  renderSuiteAction: (
    suite: string,
    choices: readonly OfficialWrapperToolChoice[]
  ) => React.ReactNode
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
      headerDivider={false}
      onBack={onBack}
      action={
        <IconButton aria-label={wrapperCopy.closeCatalog} disabled={busy} onClick={onClose}>
          <PhiIcons.action.close size={20} />
        </IconButton>
      }
    >
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Box
          data-phi-wrapper-suite-header="true"
          sx={{ px: 3, pt: 0.5, pb: 2, display: 'flex', alignItems: 'center', gap: 2 }}
        >
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0, flex: 1 }}>
            <Typography variant="h5" noWrap sx={{ fontWeight: 700 }}>
              {suite}
            </Typography>
            {loading ? null : (
              <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
                {wrapperCopy.toolCount(choices.length)}
              </Typography>
            )}
          </Box>
          <Box
            data-phi-wrapper-suite-header-action="true"
            sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}
          >
            {loading || choices.length === 0 ? null : renderSuiteAction(suite, choices)}
          </Box>
        </Box>
        <Divider data-phi-wrapper-suite-divider="true" />
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' }
          }}
        >
          <Box
            sx={{
              width: { xs: '100%', md: 260 },
              flex: { xs: '0 0 auto', md: '0 0 260px' },
              maxHeight: { xs: '44%', md: 'none' },
              minHeight: 0,
              px: 2,
              pt: 2,
              display: 'flex',
              flexDirection: 'column',
              borderRightWidth: { xs: 0, md: 1 },
              borderRightStyle: 'solid',
              borderBottomWidth: { xs: 1, md: 0 },
              borderBottomStyle: 'solid',
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
            sx={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', px: 3, pt: 2.5 }}
          >
            {feedback ? <Box sx={{ mb: 2, '&:empty': { display: 'none' } }}>{feedback}</Box> : null}
            {selected && selectedDetail ? (
              <OfficialWrapperDetailContent detail={selectedDetail} choice={selected.choice} />
            ) : detailLoading || (selectedToolId && !selectedDetail) ? (
              <DetailLoading />
            ) : (
              <Typography color="text.secondary">{wrapperCopy.noSuiteTools}</Typography>
            )}
          </Box>
        </Box>
      </Box>
    </CatalogDetailFrame>
  )
}
