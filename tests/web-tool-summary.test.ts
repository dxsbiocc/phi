import assert from 'node:assert/strict'
import test from 'node:test'
import { webToolSummary } from '../src/renderer/src/features/chat/lib/webToolSummary'

test('PubMed web fetch exposes the decoded search terms', () => {
  assert.deepEqual(
    webToolSummary(
      'web_fetch',
      JSON.stringify({
        url: 'https://pubmed.ncbi.nlm.nih.gov/?term=MID1IP1+OR+Mig12+OR+%22S14-R%22&sort=date'
      })
    ),
    {
      headline: 'PubMed 检索：MID1IP1 OR Mig12 OR "S14-R"',
      query: 'MID1IP1 OR Mig12 OR "S14-R"'
    }
  )
})

test('a fetched PubMed article is labelled by PMID instead of pretending it was a search', () => {
  assert.deepEqual(
    webToolSummary(
      'web_fetch',
      JSON.stringify({
        url: 'https://pubmed.ncbi.nlm.nih.gov/42522649/'
      })
    ),
    { headline: 'PubMed 文献：PMID 42522649' }
  )
})

test('ordinary web search keeps its explicit query visible', () => {
  assert.deepEqual(
    webToolSummary('web_search', JSON.stringify({ query: 'THRSP liver metabolism' })),
    {
      headline: '网页搜索：THRSP liver metabolism',
      query: 'THRSP liver metabolism'
    }
  )
})
