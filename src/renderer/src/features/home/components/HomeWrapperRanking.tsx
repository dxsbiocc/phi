import { homeCopy } from '../lib/homeCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Box, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'

import type { RankedWrapper } from '../lib/homeOverview'
import { resourceCatalogCopy } from '../../../lib/resourceUi'

interface HomeWrapperRankingProps {
  ranking: RankedWrapper[]
  totalRuns: number
  embedded?: boolean
}

export function HomeWrapperRanking({
  ranking,
  totalRuns,
  embedded = false
}: HomeWrapperRankingProps): React.JSX.Element {
  useUiLanguage()
  const maximum = ranking[0]?.count ?? 1

  return (
    <Box
      data-phi-home-wrapper-ranking="true"
      sx={{
        minWidth: 0,
        ...(embedded
          ? { mt: 1.5, pt: 1.5, borderTop: 1, borderColor: 'divider' }
          : {
              alignSelf: 'start',
              border: 1,
              borderColor: 'divider',
              borderRadius: 3,
              bgcolor: 'background.paper',
              p: { xs: 2, md: 2.5 }
            })
      }}
    >
      <Typography variant={embedded ? 'body2' : 'subtitle1'} sx={{ fontWeight: 750 }}>
        {resourceCatalogCopy.wrapperRanking}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.25 }}>
        {resourceCatalogCopy.savedRuns(totalRuns)}
      </Typography>
      {ranking.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: embedded ? 1 : 3 }}>
          {resourceCatalogCopy.noWrapperRuns}
        </Typography>
      ) : (
        <Box sx={{ mt: embedded ? 1.25 : 2.5 }}>
          {ranking.map((entry, index) => (
            <Box key={entry.id} sx={{ mb: index < ranking.length - 1 ? 2.25 : 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ width: 20 }}>
                  {String(index + 1).padStart(2, '0')}
                </Typography>
                <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0, fontWeight: 700 }}>
                  {entry.name}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
                >
                  {`${entry.count} ${homeCopy.runs}`}
                </Typography>
              </Box>
              <Box
                sx={{
                  mt: 0.75,
                  ml: 3.5,
                  height: 6,
                  borderRadius: 999,
                  bgcolor: (theme) => alpha(theme.palette.text.primary, 0.07)
                }}
              >
                <Box
                  sx={{
                    height: '100%',
                    width: `${Math.max(8, (entry.count / maximum) * 100)}%`,
                    borderRadius: 999,
                    bgcolor: 'primary.main'
                  }}
                />
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
