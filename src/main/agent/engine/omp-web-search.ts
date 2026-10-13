// OMP web search provider choices, kept out of omp-internals.ts because that file
// loads OMP modules with JSON imports that Node cannot run without import
// attributes, and web-search-settings.ts is loaded by Node-run tests.

import {
  SEARCH_PROVIDER_CHOICES as OMP_SEARCH_PROVIDER_CHOICES,
  type SearchProviderId as OmpSearchProviderId
} from '@oh-my-pi/pi-coding-agent/web/search/types'

import type { PhiWebSearchProvider } from './types'

type AssertAssignable<Actual extends Expected, Expected> = Actual

export type SearchProviderId = PhiWebSearchProvider

export interface PhiSearchProviderChoice {
  value: SearchProviderId
  label: string
  description: string
}

export const SEARCH_PROVIDER_CHOICES: readonly PhiSearchProviderChoice[] =
  OMP_SEARCH_PROVIDER_CHOICES

type OmpTypeCompatibilityChecks = [
  AssertAssignable<OmpSearchProviderId, SearchProviderId>,
  AssertAssignable<SearchProviderId, OmpSearchProviderId>
]
const ompTypeCompatibilityChecks: OmpTypeCompatibilityChecks | undefined = undefined
void ompTypeCompatibilityChecks
