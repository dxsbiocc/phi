import { homeCopy } from '../lib/homeCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Box } from '@mui/material'
import type { HomeActivitySummary } from '../../../types'
import { HomeActivityHeatmap } from './HomeActivityHeatmap'
import { HomeCarousel } from './HomeCarousel'
import {
  HomeRecentWorkCard,
  HomeResourcesCard,
  type HomeOverviewCardsProps
} from './HomeOverviewCards'
import { HomePeriodSummary } from './HomePeriodSummary'

export function HomeLowerLayout({
  activity,
  activityLoading,
  overview
}: {
  activity: HomeActivitySummary | null
  activityLoading: boolean
  overview: HomeOverviewCardsProps
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <HomeCarousel labels={[homeCopy.activityOverThePastYear, homeCopy.continueRecentWork]}>
        <HomeActivityHeatmap activity={activity} loading={activityLoading} />
        <HomeRecentWorkCard {...overview} />
      </HomeCarousel>
      <Box
        data-phi-home-companion-row="true"
        sx={{
          display: 'grid',
          width: '100%',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
          gap: 2,
          alignItems: 'stretch',
          '& > *': { minWidth: 0, width: '100%' }
        }}
      >
        <HomePeriodSummary activity={activity} loading={activityLoading} />
        <HomeResourcesCard {...overview} />
      </Box>
    </Box>
  )
}
