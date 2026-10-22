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

type HomeLowerLayoutProps = {
  activity: HomeActivitySummary | null
  activityLoading: boolean
  overview: HomeOverviewCardsProps
}

export function HomeCarouselSection({
  activity,
  activityLoading,
  overview
}: HomeLowerLayoutProps): React.JSX.Element {
  useUiLanguage()
  return (
    <HomeCarousel labels={[homeCopy.activityOverThePastYear, homeCopy.continueRecentWork]}>
      <HomeActivityHeatmap activity={activity} loading={activityLoading} />
      <HomeRecentWorkCard {...overview} />
    </HomeCarousel>
  )
}

export function HomeCompanionRow({
  activity,
  activityLoading,
  overview
}: HomeLowerLayoutProps): React.JSX.Element {
  useUiLanguage()
  return (
    <Box
      data-phi-home-companion-row="true"
      sx={{
        display: 'grid',
        width: '100%',
        mt: 2,
        gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
        gap: 2,
        alignItems: 'stretch',
        '& > *': { minWidth: 0, width: '100%' }
      }}
    >
      <HomePeriodSummary activity={activity} loading={activityLoading} />
      <HomeResourcesCard {...overview} />
    </Box>
  )
}
