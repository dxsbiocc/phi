# Cancer/Clinical Connector Plan

Per-family plan for the **cancer/clinical** connector in M3 of the
[data access implementation plan](data-access-implementation.md). It depends on M1
(connector contract additions and the stdlib Python MCP kit) and M2 (the evaluation arm).
Status: planned, next release. Not part of the internal beta.

Update (2026-10-23): BioMCP, already in Phi's catalog, covers most of the live lookups
below. The proposed [clinical knowledge service](../design/phi-clinical-knowledge-service.md)
covers cross-source joins, curated facts and a commercial-clean licence. Whether C1–C4
are still built is decision 4 in that document.

## Decisions (2026-10-23)

- **Phi is a commercial product.** This connector uses only upstream sources whose terms
  allow commercial use, including caching results and showing them to users inside a paid
  product. Sources that are non-commercial, academic-only, share-alike, or unverified are
  excluded or deferred (§ 3).
- **No OnCo data.** [OnCo](https://github.com/judegomila/OnCo) code is MIT, but its corpus
  (`src/data/`) is CC BY-NC 4.0, which explicitly counts a company's internal data
  pipeline as commercial use. Phi does not ship, copy, transform or query the OnCo corpus
  or its API. Its MIT fetch scripts may be read as reference for request shapes; any
  ported logic keeps the MIT notice. Its `docs/DATA-SOURCES.md` is a useful licence
  survey, but every entry used here was re-checked at the source (§ 2).
- **Live queries, not a bundled knowledge base.** Every tool calls the upstream API at
  request time through the M1 kit (retry, per-host rate limits, short-lived cache).
  Phi builds no curated corpus, so there is no Phi-owned dataset to license or keep fresh.
- **No curation layer.** Summaries, comparisons and cross-source links (drug → trials →
  biomarker evidence → targets) are composed by the Database agent at query time from
  tool results, each claim citing the tool result it came from. The connector's job is
  deterministic: correct identifiers, complete pages, and batch inputs so one question
  does not need dozens of calls.
- **One connector, small task-shaped tools**, attached only to the Database agent
  (`attachTo`, M1). No generic query language.

## 1. Tools

| Tool                    | Source                            | Input                                                                                                 | Returns                                                                                                                                       |
| ----------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `trials_search`         | ClinicalTrials.gov API v2         | `condition`, `intervention?`, `term?` (e.g. biomarker), `status?`, `phase?`, `country?`, `pageToken?` | NCT id, title, overall status, phases, conditions, interventions, lead sponsor, start / primary-completion dates, enrolment; `nextPageToken`  |
| `trial_get`             | ClinicalTrials.gov API v2         | `nct`                                                                                                 | Design, arms and interventions, eligibility text, primary / secondary outcomes, location countries and site count, whether results are posted |
| `label_get`             | openFDA drug label (DailyMed SPL) | `name` (generic or brand) or `setId`; `sections?`                                                     | Indications and usage, boxed warning, dosage, warnings, adverse-reactions excerpts; SPL set id, version date and DailyMed link                |
| `approvals_list`        | openFDA `drugsfda`                | `name` or `applicationNumber`                                                                         | Application number and type (NDA / BLA), sponsor, products, submissions with dates, types and status                                          |
| `adverse_event_counts`  | openFDA FAERS                     | `name`, `top?`                                                                                        | Most-reported reactions with counts and the query date range; always labelled as spontaneous reports that do not establish causation          |
| `variant_evidence`      | CIViC GraphQL                     | `gene`, `variant?`, `disease?`, `evidenceType?`                                                       | Evidence items: level, type, direction, significance, disease, therapies, source PMID, CIViC URL                                              |
| `biomarker_assertions`  | CIViC GraphQL                     | `gene`, `variant?`, `disease?`                                                                        | Curated assertions with AMP/ASCO/CAP tier, NCCN-guideline flag as recorded by CIViC, FDA companion-test flag, therapies                       |
| `target_disease_scores` | Open Targets Platform GraphQL     | `target` (symbol / Ensembl id) **or** `disease` (EFO id / name), `top?`                               | Associations with overall and per-datatype scores, Ensembl / EFO ids, Open Targets URLs. Scores only; no evidence text (§ 3.2)                |

Shared rules for every tool:

- **Bounded output.** Default page sizes stay small (10–20 rows); long text fields are
  truncated with an explicit marker, and the tool says how to fetch more.
- **Provenance block** on every result: `source`, `licence`, `url` of the underlying
  request or record, `retrievedAt`, the upstream data date when the API exposes one
  (ClinicalTrials.gov `dataTimestamp`, SPL version date), and `modifications`
  (fields selected, text truncated). This satisfies the ClinicalTrials.gov terms (§ 2)
  and the attribution requests of the others.
- **No personal contact data.** Trial contacts and site investigators' e-mail addresses
  and phone numbers are dropped. ClinicalTrials.gov forbids using extracted e-mail
  addresses for marketing, and the agent never needs them.
- **Errors** come back as MCP `isError` results with the upstream status and a short
  reason. A partially failed fan-out returns an error, not an answer built from the rest.
- **Research use wording.** Tool descriptions say results are for research orientation,
  not clinical decisions.

## 2. Sources and terms (checked 2026-10-23)

| Source                                   | Terms read at the source                                                                                                                                                                                                                                                                      | Conditions the connector implements                                                                                                    | Rate limit / key                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| ClinicalTrials.gov API v2                | [Terms and conditions](https://clinicaltrials.gov/about-site/terms-conditions) (updated 2023-01-31): data free to all requesters; on distribution, attribute ClinicalTrials.gov, keep data current, show the processing date, state modifications; no proprietary claims; no e-mail marketing | Provenance block with `dataTimestamp` and `modifications`; cache TTL ≤ 24 h; contacts dropped                                          | Not published; the kit applies a conservative per-host limit                                                 |
| openFDA (label, drugsfda, FAERS)         | [Terms](https://open.fda.gov/terms/): CC0 1.0, commercial use allowed; credit requested; some flagged data are not public domain; GMDN content needs its own licence                                                                                                                          | Credit line; device / GMDN endpoints are not used                                                                                      | No key: 240/min, 1,000/day per IP. Free key: 120,000/day ([auth](https://open.fda.gov/apis/authentication/)) |
| DailyMed (via openFDA label, links only) | [NLM web policies](https://www.nlm.nih.gov/web_policies.html#copyright): US government works freely reusable; third-party content may carry its own copyright                                                                                                                                 | Label text comes from openFDA (CC0); DailyMed is used for record links and set ids                                                     | —                                                                                                            |
| CIViC                                    | [FAQ](https://civic.readthedocs.io/en/latest/about/faq.html): content CC0 1.0, code MIT; citing Griffith et al. 2017 requested                                                                                                                                                                | Citation in the provenance block                                                                                                       | To be measured in M3; anonymous access works                                                                 |
| Open Targets Platform                    | [Licence](https://platform-docs.opentargets.org/licence): platform data CC0 1.0; each underlying source keeps its own licence                                                                                                                                                                 | Return Open Targets-computed scores and identifiers only; never relay evidence rows from share-alike or non-commercial sources (§ 3.2) | To be measured in M3                                                                                         |

Each source's terms are re-read when the connector's version changes. A change that
removes commercial use disables that tool in the next connector release.

## 3. Excluded and deferred

### 3.1 Excluded

| Source                               | Reason                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| OnCo corpus and API                  | CC BY-NC 4.0                                                                     |
| OncoKB                               | Personal or academic use only; no redistribution without an MSK licence          |
| COSMIC                               | Commercial licence required for products and public-facing services              |
| DrugBank (beyond its CC0 vocabulary) | Non-commercial; commercial licence required                                      |
| KEGG                                 | Academic users only                                                              |
| NCCN guidelines                      | Non-commercial, not redistributable                                              |
| Semantic Scholar                     | API licence limited to non-commercial research                                   |
| jRCT, ChiCTR                         | All rights reserved; automated collection prohibited                             |
| cBioPortal (this release)            | ODbL, and some hosted studies restrict commercial use; needs per-study filtering |

### 3.2 Inside Open Targets

Open Targets aggregates sources under mixed licences. ChEMBL and Human Protein Atlas are
CC BY-SA 3.0, and Europe PMC text-mining evidence includes non-commercial items. So this
connector does **not** expose Open Targets `knownDrugs` (ChEMBL-derived) or evidence
rows. Drug-target mechanisms belong in the chemistry family, which handles ChEMBL's
share-alike terms separately.

### 3.3 Deferred (candidates once terms are confirmed)

| Source                         | What it would add                   | Open question                                                                                         |
| ------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| NCI GDC (open tier)            | Mutation frequency per TCGA project | Data-access policy asks for dataset acknowledgement; confirm commercial reuse of open-tier summaries  |
| EMA medicines data             | EU authorisation status and dates   | Legal notice allows commercial reuse with acknowledgement; confirm the JSON dumps' fields and cadence |
| NCI PDQ summaries              | Plain-language treatment overviews  | Text reusable with NCI credit; confirm a machine-readable feed and the PDQ trademark rules            |
| FDA companion diagnostics list | Device-biomarker-drug pairs         | HTML table only; no stated reuse terms on the page                                                    |
| GLOBOCAN (IARC)                | Incidence and mortality             | Terms page unreachable when checked; IARC content is often non-commercial                             |

### 3.4 Legal review before release

ClinicalTrials.gov's terms also state that the data "carry an international copyright
outside the United States". Phi has users outside the US, so this clause and the attribution
wording need a legal check before the connector is listed in the official catalog.

## 4. Package and runtime

- Package `cancer-clinical`, `type: mcp`, `connector.transport: stdio`,
  `connector.category: 健康与生命科学`, environment `phi:python@1`, server built on the M1 kit
  (stdlib only).
- `attachTo: database` (M1). Not visible to the main agent.
- openFDA key: optional. v1 runs keyless, since 1,000 requests a day per IP is enough for
  one desktop user. When M1's `secrets` support lands, an optional `OPENFDA_API_KEY` raises
  the daily limit. The key is stored in the credential store and passed only to this
  server's process.
- Cache: in-process plus the kit's disk cache under the package's runtime cache, keyed by
  request; TTL ≤ 24 h for ClinicalTrials.gov and FAERS, 7 days for labels, approvals,
  CIViC and Open Targets (all versioned upstream).

Note: [connector contract](../contracts/connector.md) still says "public REST databases
are API skills, not connectors". M1 updates that sentence together with `secrets` and
`attachTo`.

## 5. Steps

| Step | Scope                                                                                            | Done when                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| C1   | Clinical trials: `trials_search`, `trial_get`, provenance block, contact stripping               | Eval tasks T1–T4 pass; recorded responses replay offline in unit tests                       |
| C2   | FDA: `label_get`, `approvals_list`, `adverse_event_counts`                                       | T5–T8 pass; keyless limits hold under the eval's batch tasks                                 |
| C3   | Biomarker evidence: `variant_evidence`, `biomarker_assertions`                                   | T9–T10 pass                                                                                  |
| C4   | Target-disease: `target_disease_scores`, excluding share-alike / non-commercial evidence (§ 3.2) | T11–T12 pass; a test asserts that no evidence rows or `knownDrugs` fields leave the server   |
| C5   | Packaging, catalog entry, terms re-check, legal review of § 3.4                                  | Installs from the registry, answers only through the Database agent, legal sign-off recorded |

## 6. Evaluation tasks (for the M2 arm)

Each task is run against the connector and against plain URL reading.

| #   | Task                                                                              |
| --- | --------------------------------------------------------------------------------- |
| T1  | Recruiting phase 3 trials for KRAS G12C non-small cell lung cancer, with sponsors |
| T2  | Eligibility criteria and primary outcome of a given NCT number                    |
| T3  | Count of interventional trials for a drug by phase (pagination)                   |
| T4  | Trials for a condition with recruiting sites in a given country                   |
| T5  | Boxed warning and indications from the current US label of a named oncology drug  |
| T6  | First approval date and application number of a named biologic                    |
| T7  | All supplemental approvals of a drug after a given year                           |
| T8  | Top reported adverse reactions for a drug, with the date range stated             |
| T9  | CIViC predictive evidence for EGFR T790M in lung cancer, with levels and PMIDs    |
| T10 | CIViC assertions for BRAF V600E with their AMP/ASCO/CAP tiers                     |
| T11 | Top diseases associated with a target, with per-datatype scores                   |
| T12 | Top targets for a disease (EFO id), returning identifiers and scores only         |
