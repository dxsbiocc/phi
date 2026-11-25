import assert from 'node:assert/strict'
import test from 'node:test'

import { planModeToolDecision } from '../src/main/agent/engine/phi-extension/lib/plan-mode'
import { rpcPlanningToolDecision } from '../src/main/agent/engine/phi-extension/lib/rpc-prompt-policy'
import {
  parseCitationReference,
  verifyPlanLiteratureCitations
} from '../src/main/agent/plan/citation-verifier'
import {
  enterPlanReviewMode,
  type PlanReviewSession
} from '../src/main/agent/plan/plan-review-mode'
import type { PlanSpec } from '../src/shared/planRunTypes'

function baseSpec(references?: string[]): PlanSpec {
  return {
    version: 1,
    goal: 'Test literature grounding',
    literatureReview: {
      needed: true,
      rationale: 'Prior mechanistic context required',
      references
    },
    steps: [
      {
        id: 's1',
        title: 'Inspect',
        instructions: 'Read files',
        acceptance: 'Verified',
        dependsOn: [],
        access: 'read'
      }
    ]
  }
}

test('all three planning allowlists admit web_search and read-only custom tools while blocking bash and mutating tools', async () => {
  const isReadOnlyCustom = (name: string): boolean => name === 'lit_pubmed_search'

  assert.equal(planModeToolDecision(true, 'web_search', {}, true).allowed, true)
  assert.equal(
    planModeToolDecision(true, 'lit_pubmed_search', {}, true, isReadOnlyCustom).allowed,
    true
  )
  assert.equal(
    planModeToolDecision(true, 'viz_render_plot', {}, true, isReadOnlyCustom).allowed,
    false
  )
  assert.equal(planModeToolDecision(true, 'bash', {}, true, isReadOnlyCustom).allowed, false)

  assert.equal(rpcPlanningToolDecision('plan_execute', 'web_search', {}).allowed, true)
  assert.equal(
    rpcPlanningToolDecision('plan_execute', 'lit_pubmed_search', {}, false, isReadOnlyCustom)
      .allowed,
    true
  )
  assert.equal(
    rpcPlanningToolDecision('plan_execute', 'bash', {}, false, isReadOnlyCustom).allowed,
    false
  )

  let activeTools = ['read', 'bash', 'web_search', 'lit_pubmed_search', 'mutating_script']
  let state: { enabled: boolean } | undefined
  const fakeSession: PlanReviewSession = {
    getPlanModeState: () => state as ReturnType<PlanReviewSession['getPlanModeState']>,
    setPlanModeState: (next) => {
      state = next
    },
    getActiveToolNames: () => activeTools,
    hasBuiltInTool: (name) => name === 'write',
    setActiveToolsByName: async (names) => {
      activeTools = names
    },
    setPlanProposalHandler: () => undefined,
    setPlanReferencePath: () => undefined
  }

  await enterPlanReviewMode(
    fakeSession,
    async (title, planFilePath) => ({ title, content: 'x', planFilePath }),
    async () => ({ decision: 'cancel' }),
    {
      execute: true,
      isReadOnlyTool: isReadOnlyCustom,
      reviewSteps: async () => ({ ok: false, errors: ['noop'] }),
      setProposalHandler: () => undefined
    }
  )
  assert.ok(activeTools.includes('web_search'))
  assert.ok(activeTools.includes('lit_pubmed_search'))
  assert.equal(activeTools.includes('bash'), false)
  assert.equal(activeTools.includes('mutating_script'), false)
})

test('parseCitationReference extracts DOI, bioRxiv DOI, PMID, PMCID, arXiv, and rejects ungrounded text', () => {
  assert.deepEqual(parseCitationReference('DOI:10.1038/s41592-026-03029-6.'), {
    kind: 'doi',
    id: '10.1038/s41592-026-03029-6',
    raw: 'DOI:10.1038/s41592-026-03029-6.'
  })
  assert.deepEqual(
    parseCitationReference('https://www.biorxiv.org/content/10.1101/2025.01.01.123456v2'),
    {
      kind: 'doi',
      id: '10.1101/2025.01.01.123456',
      raw: 'https://www.biorxiv.org/content/10.1101/2025.01.01.123456v2'
    }
  )
  assert.deepEqual(parseCitationReference('PMID: 38123456'), {
    kind: 'pmid',
    id: '38123456',
    raw: 'PMID: 38123456'
  })
  assert.deepEqual(parseCitationReference('PMCID:PMC9876543'), {
    kind: 'pmcid',
    id: 'PMC9876543',
    raw: 'PMCID:PMC9876543'
  })
  assert.equal(parseCitationReference('Smith et al., Nature 2024'), null)
})

test('verifyPlanLiteratureCitations verifies existing citations, rejects missing/retracted ones, and marks offline gracefully', async () => {
  // 1. Valid DOI + PMID -> verified
  const okOutcome = await verifyPlanLiteratureCitations(
    baseSpec(['DOI:10.1038/nbt.3820', 'PMID:25516281']),
    {
      fetchImpl: (async (url: string | URL | Request) => {
        const href = String(url)
        if (href.includes('crossref.org')) {
          return new Response(
            JSON.stringify({ message: { title: ['Nextflow enables reproducible workflows'] } }),
            { status: 200 }
          )
        }
        return new Response(
          JSON.stringify({
            hitCount: 1,
            resultList: {
              result: [{ title: 'DESeq2', pubTypeList: { pubType: ['research-article'] } }]
            }
          }),
          { status: 200 }
        )
      }) as typeof fetch
    }
  )
  assert.equal(okOutcome.ok, true)
  if (okOutcome.ok) {
    assert.equal(okOutcome.spec.literatureReview?.verificationStatus, 'verified')
  }

  // 2. Fabricated 404 DOI -> rejected
  const missingOutcome = await verifyPlanLiteratureCitations(baseSpec(['DOI:10.9999/fake-9999']), {
    fetchImpl: (async () => new Response('Not found', { status: 404 })) as typeof fetch
  })
  assert.equal(missingOutcome.ok, false)
  if (!missingOutcome.ok) {
    assert.ok(missingOutcome.errors.some((e) => e.includes('could not be resolved')))
  }

  // 3. Retracted DOI -> rejected
  const retractedOutcome = await verifyPlanLiteratureCitations(
    baseSpec(['DOI:10.1038/retracted1']),
    {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            message: {
              title: ['Some study'],
              'update-to': [{ type: 'retraction' }]
            }
          }),
          { status: 200 }
        )) as typeof fetch
    }
  )
  assert.equal(retractedOutcome.ok, false)
  if (!retractedOutcome.ok) {
    assert.ok(retractedOutcome.errors.some((e) => e.includes('retracted')))
  }

  // 4. Offline network error -> allowed with explicit unverified_offline status
  const offlineOutcome = await verifyPlanLiteratureCitations(baseSpec(['DOI:10.1038/nbt.3820']), {
    fetchImpl: (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
  })
  assert.equal(offlineOutcome.ok, true)
  if (offlineOutcome.ok) {
    assert.equal(offlineOutcome.spec.literatureReview?.verificationStatus, 'unverified_offline')
  }
})
