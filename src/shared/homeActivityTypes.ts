export interface HomeActivityDay {
  date: string
  durationMs: number
  completedRuns: number
  totalRuns: number
}

export interface HomeActivityPeriodSummary {
  durationMs: number
  completedRuns: number
  totalRuns: number
  activeDays: number
}

export interface HomeActivitySummary {
  generatedAt: string
  dayBuckets: HomeActivityDay[]
  periods: {
    week: HomeActivityPeriodSummary
    month: HomeActivityPeriodSummary
    year: HomeActivityPeriodSummary
  }
}
