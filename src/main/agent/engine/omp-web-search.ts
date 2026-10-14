// OMP web search provider choices, kept out of omp-internals.ts because that file
// loads OMP modules with JSON imports that Node cannot run without import
// attributes, and web-search-settings.ts is loaded by Node-run tests.

import {
  SEARCH_PROVIDER_LABELS,
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

// Phi preserves its existing selectable providers. New SDK grounding backends
// need a deliberate auth/UI contract before becoming selectable in Phi.
const descriptions: Record<SearchProviderId, string> = {
  perplexity: 'Uses auth when configured; explicit selection falls back to anonymous search',
  gemini: 'Google Search grounding via Gemini (uses google-gemini-cli or google-antigravity OAuth)',
  anthropic: "Claude's native web_search tool (uses Anthropic OAuth or ANTHROPIC_API_KEY)",
  codex: "OpenAI's native web_search (uses ChatGPT OAuth via /login openai-codex)",
  xai: 'Grok web search via xAI Responses API (uses SuperGrok/X Premium+ OAuth via /login xai-oauth, or XAI_API_KEY)',
  zai: 'Calls Z.AI webSearchPrime MCP',
  exa: 'API via /login exa or EXA_API_KEY; explicit keyless fallback via MCP',
  tinyfish: 'Requires TINYFISH_API_KEY',
  jina: 'Requires JINA_API_KEY',
  kagi: 'Requires KAGI_API_KEY and Kagi Search API beta access',
  tavily: 'Requires TAVILY_API_KEY',
  firecrawl: 'Uses Firecrawl API when FIRECRAWL_API_KEY is set; falls back to keyless mode',
  brave: 'Requires BRAVE_API_KEY',
  kimi: 'Kimi Code search (requires a Kimi Code Console key via KIMI_SEARCH_API_KEY/MOONSHOT_SEARCH_API_KEY or /login kimi-code; not MOONSHOT_API_KEY)',
  parallel: 'Requires PARALLEL_API_KEY',
  synthetic: 'Requires SYNTHETIC_API_KEY',
  searxng: 'Requires SEARXNG_ENDPOINT or searxng.endpoint',
  startpage: 'Credential-free scrape of Startpage (Google-backed) results; may be bot-challenged',
  duckduckgo:
    'Credential-free best-effort fallback; may be bot-challenged on datacenter/shared-egress IPs',
  ecosia: 'Credential-free browser-backed scrape of Ecosia (Google-backed) results',
  google: 'Credential-free browser-backed fallback; slower and may be bot-challenged',
  mojeek: "Credential-free browser-backed scrape of Mojeek's independent index",
  public: 'Queries every credential-free engine in parallel and consolidates deduplicated results'
}
export const SEARCH_PROVIDER_CHOICES: readonly PhiSearchProviderChoice[] = Object.entries(
  descriptions
).map(([value, description]) => ({
  value: value as SearchProviderId,
  label: SEARCH_PROVIDER_LABELS[value as SearchProviderId],
  description
}))

type OmpTypeCompatibilityChecks = [AssertAssignable<SearchProviderId, OmpSearchProviderId>]
const ompTypeCompatibilityChecks: OmpTypeCompatibilityChecks | undefined = undefined
void ompTypeCompatibilityChecks
