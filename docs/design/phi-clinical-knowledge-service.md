# Clinical Knowledge Service

Status: proposal, 2026-10-23. Not part of the internal beta. Needs a server (none exists
yet) and the decisions in § 9.

Phi gets a self-hosted, commercially licensable oncology knowledge base, served as an
online MCP connector. The Database agent queries it the same way it queries any other
connector. This extends the [cancer/clinical connector plan](../roadmap/data-access-cancer-clinical-connector.md),
which covered live upstream lookups only.

## 1. Why a knowledge base, and what it is not

**What live lookups already cover.** Phi's catalog already offers
[BioMCP](https://github.com/genomoncology/biomcp) (MIT), which queries ClinicalTrials.gov,
openFDA, CIViC, Open Targets, ClinVar, PubMed and more at request time. A second
live-lookup connector would mostly duplicate it.

**What live lookups cannot do**, and what this service is for:

1. **Cross-source joins and aggregation.** "Approved TROP2 ADCs, their pivotal trials and
   which biomarkers gate them" takes dozens of live calls. One query over a normalised
   graph answers it.
2. **Stable identifiers across sources.** Drug, disease, gene and variant names resolve
   to one canonical record, so the agent does not have to guess mappings.
3. **Facts no API provides.** These need manual or agent-assisted curation: China / Japan
   approvals, standard-of-care lines, pivotal efficacy numbers, modality attributes
   (§ 5.2).
4. **A clean licence.** Every stored fact comes from a source whose terms allow commercial
   reuse, and carries its provenance. BioMCP also calls non-commercial or restricted
   sources (OncoKB, KEGG, Semantic Scholar, DisGeNET, COSMIC cross-references). That is
   the user's own use when they run it, but it cannot back a Phi-hosted service.

**Not in scope:**

- Plain-language summaries or narrative pages. The agent writes those at query time
  from tool results.
- Patient data of any kind.
- Clinical decision support. The service is positioned for research and translational
  use (§ 8).

## 2. Architecture (inside out)

```text
 upstream bulk files / APIs ──► source adapters ──► staging (raw, per source, versioned)
                                                         │
 curated fact repo (git, YAML) ──► schema validation ──►─┤
                                                         ▼
                                   normaliser: ID crosswalk + merge + conflict checks
                                                         │
                                                         ▼
                              knowledge store (PostgreSQL: entities, facts, edges, provenance)
                                                         │
                                       MCP server (streamable HTTP, API key) ──► Phi connector
```

- **Source adapters** download bulk files where they exist, and use paged APIs where
  they do not. Each run writes an immutable, dated staging snapshot, so any release
  can be rebuilt.
- **Curated fact repo.** Hand-entered and agent-extracted facts live in a separate git
  repository as YAML, one file per record. CI validates the schema, identifiers and
  citations. Every change is a reviewed pull request, which gives an audit trail for
  free.
- **Normaliser.** Maps every record to canonical IDs (§ 3), merges records, and flags
  conflicts, for example an approval date that differs between openFDA and a curated
  fact. Conflicts block a release until someone resolves them.
- **Knowledge store.** PostgreSQL is enough: entity tables, a typed edge table, a fact
  table with provenance columns, and `pg_trgm` for name search. A graph database is not
  needed at this size.
- **MCP server.** Python, over streamable HTTP, with API-key authentication. It is
  read-only against the store. It is installed in Phi as a `type: mcp` connector package
  with `transport: http` and `auth: header`, attached to the Database agent only.

## 3. Data model

### 3.1 Entity kinds and canonical identifiers

| Kind                | Canonical ID                                            | Crosswalk sources                                                    |
| ------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| Disease / cancer    | MONDO (primary), NCIt code                              | MONDO equivalents; NCIt; OncoTree code (licence to confirm, § 4)     |
| Gene / target       | HGNC id                                                 | HGNC → Ensembl, Entrez, UniProt                                      |
| Variant / biomarker | Gene + HGVS (protein), ClinVar VCV when present         | CIViC molecular profiles, ClinVar                                    |
| Drug / product      | UNII                                                    | GSRS / UNII; RxNorm RxCUI (NLM-owned content only); PubChem CID      |
| Trial               | NCT number                                              | ClinicalTrials.gov; curated aliases (for example "DESTINY-Breast04") |
| Regulatory approval | Regulator + application / procedure number + indication | Drugs@FDA, EMA, curated (NMPA, PMDA)                                 |
| Label               | SPL set id + version                                    | openFDA label                                                        |
| Evidence item       | CIViC EID / AID                                         | CIViC                                                                |
| Publication         | PMID, DOI                                               | PubMed, OpenAlex                                                     |
| Organisation        | ROR id                                                  | ROR (CC0), trial sponsors, application holders                       |

WHO ATC codes cannot be used, because ATC/DDD forbids commercial distribution. Drug class
and modality come from Phi's own taxonomy instead (§ 5.2).

### 3.2 Facts and provenance

Every stored fact or edge carries:

| Field           | Meaning                                      |
| --------------- | -------------------------------------------- |
| `source`        | Registry id of the source (§ 4)              |
| `sourceRecord`  | Upstream id or URL of the exact record       |
| `sourceVersion` | Upstream release or data timestamp           |
| `retrievedAt`   | When the adapter fetched it                  |
| `method`        | `bulk`, `api`, `manual` or `agent-extracted` |
| `reviewedBy`    | Required for `manual` and `agent-extracted`  |
| `asOf`          | Date the fact was last confirmed             |

The MCP server returns these fields with every result, together with the attribution text
each licence requires.

## 4. Source registry: automatic ingestion

Terms were read at the source on 2026-10-23, except where marked. The registry is a
table in the store. A release fails if any source's terms check is older than its review
interval.

| Source                    | Content                                                 | Access and cadence                                                                                       | Terms                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ClinicalTrials.gov        | All trials, eligibility, arms, outcomes, posted results | API v2 full pull, then daily incremental by last-update date                                             | Free use; attribute, keep current, show processing date, state modifications; no e-mail marketing. Note: the "international copyright outside the US" clause still needs legal review |
| openFDA                   | Labels, Drugs@FDA applications, FAERS counts            | Bulk download files (weekly); API for gaps                                                               | CC0; credit requested; avoid flagged non-public-domain data and GMDN content                                                                                                          |
| FDA GSRS / UNII           | Substance identifiers and names                         | openFDA `other/substance` bulk file (the precision.fda.gov archive returns 403 from the mainland, § 7.1) | Public domain (FDA website policy)                                                                                                                                                    |
| EMA                       | EU authorisations, dates, indications                   | Nightly XLSX / JSON                                                                                      | Commercial reuse allowed; acknowledge EMA in each copy; no logo; third-party content excluded                                                                                         |
| CIViC                     | Evidence items, assertions, molecular profiles          | Nightly / monthly TSV releases; GraphQL for detail                                                       | Content CC0; cite Griffith et al. 2017 (requested)                                                                                                                                    |
| Open Targets              | Target-disease association scores                       | Parquet releases (EBI FTP)                                                                               | Platform data CC0. Ingest Open Targets-computed scores only; never ingest ChEMBL-derived (CC BY-SA) or Europe PMC (mixed, partly NC) evidence                                         |
| ClinVar                   | Germline and somatic variant classifications            | Weekly XML / VCF                                                                                         | Public domain (per OnCo's survey; re-check in K1)                                                                                                                                     |
| HGNC                      | Gene symbols and crosswalks                             | Bulk files (monthly)                                                                                     | CC0                                                                                                                                                                                   |
| MONDO                     | Disease ontology and equivalents                        | OWL / JSON releases (GitHub)                                                                             | CC BY 4.0; attribution                                                                                                                                                                |
| NCIt                      | Cancer terms, synonyms, hierarchy                       | EVS FTP (monthly)                                                                                        | CC BY 4.0; attribution; derivatives may not be called "NCI Thesaurus"                                                                                                                 |
| RxNorm (NLM content only) | Drug names and RxCUIs                                   | Monthly release (UMLS licence needed for the full release)                                               | NLM content freely distributable, with the NLM statement and a not-current disclaimer if stale; proprietary sources excluded                                                          |
| PubMed / OpenAlex         | Publication metadata for cited papers                   | E-utilities; OpenAlex API / snapshot                                                                     | NCBI metadata public domain (abstracts may be publisher copyright, so not stored); OpenAlex CC0                                                                                       |
| ROR                       | Organisation identifiers                                | Data dump (monthly)                                                                                      | CC0 (per OnCo's survey; re-check in K1)                                                                                                                                               |

**Deferred, terms not confirmed:** NCI GDC open tier (no licence statement; acknowledgement
asked), OncoTree data (repository says CC BY 4.0; site not reachable), CDC USCS (no reuse
terms stated), Health Canada DPD (default Canada.ca terms need written permission for
commercial redistribution), PMC OA full text (licence varies per article; bulk only via the
cloud service).

**Excluded:** OnCo corpus, OncoKB, COSMIC, DrugBank (beyond its CC0 vocabulary), KEGG, NCCN,
WHO ATC/DDD, Semantic Scholar, DisGeNET, jRCT and ChiCTR scraping, cBioPortal (study-level
restrictions), ChEMBL (share-alike would reach derived tables; it stays in the live
chemistry connector, not this store).

## 5. Curated facts

### 5.1 What needs curation and how

| Fact type                              | Why no API provides it                                                                                | Method                                                                                                                          | Rough size estimate (oncology) |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| China NMPA approvals                   | All rights reserved; no API; bulk collection not permitted                                            | Manual: drug, indication, date, approval number, link to the NMPA or company announcement. Facts only, no copied text           | ~200–400 oncology approvals    |
| Japan PMDA approvals                   | Automated / bulk download prohibited                                                                  | Manual from the PMDA list, same fields                                                                                          | ~200–300                       |
| Standard-of-care lines per cancer      | Guidelines (NCCN, ESMO) are copyrighted                                                               | Agent-assisted: derive from FDA / EMA indications plus pivotal trials; a domain reviewer approves. Never paraphrase a guideline | ~30 cancers × 2–6 lines        |
| Pivotal trial efficacy                 | Numbers live in papers and posted results                                                             | ClinicalTrials.gov posted results first (automatic); otherwise agent extraction from the paper with PMID and reviewer approval  | ~300–500 trials                |
| Trial aliases (acronym → NCT)          | Acronyms are not a registry field                                                                     | Agent-extracted from the official title, then reviewed                                                                          | ~1,000                         |
| Modality and class taxonomy            | ATC cannot be used; modality (ADC, bispecific, CAR-T…) is not upstream                                | Manual: Phi-owned taxonomy, assigned per drug                                                                                   | ~40 classes, ~800 drugs        |
| ADC / cell-therapy attributes          | Payload, linker, DAR, construct are in labels and papers as prose                                     | Agent extraction from labels (public domain) with review                                                                        | ~50 ADCs, ~30 cell therapies   |
| Biomarker cut-offs and companion tests | Thresholds sit in label text; the FDA companion-diagnostic list is an HTML table with no stated terms | Agent extraction from FDA labels (public domain) with review; device list as links only until its terms are confirmed           | ~150 drug–biomarker pairs      |

### 5.2 Agent-assisted curation pipeline

1. A curation job (a Phi agent, or a script that calls a model) reads public-domain or CC0
   sources and proposes YAML records. Each proposed value cites a source location.
2. The proposals open a pull request in the curated fact repo. CI checks the schema, IDs,
   that every value has a citation, and conflicts with ingested facts.
3. A domain reviewer approves or edits the pull request. The `reviewedBy` field records
   who approved it.
4. Every release recomputes `asOf` staleness. Facts older than their review interval
   (for example, 12 months for approvals) appear in a review queue.

Nothing agent-extracted reaches the store without review.

## 6. MCP interface

Tools are task-shaped, read-only, batch-capable, and bounded by default. All of them
return provenance (§ 3.2).

| Tool                  | Answers                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `resolve`             | Names or synonyms (batch) → canonical entities with kind, ids and match reason                                              |
| `drug_profile`        | One or more drugs: identifiers, modality, targets, approvals by region, label sections, pivotal trials                      |
| `approvals_query`     | Approvals filtered by region, cancer, target, modality and date range                                                       |
| `trials_query`        | Trials filtered by cancer, drug, biomarker, phase, status and country. Status is refreshed live when it is older than a day |
| `biomarker_landscape` | For a gene or variant (+ cancer): CIViC evidence and assertions, approved matched therapies, trials                         |
| `target_landscape`    | For a target: associated cancers (Open Targets scores), drugs by modality and phase, trials                                 |
| `standard_of_care`    | Curated lines for a cancer, each with its regulatory basis and pivotal trial                                                |
| `compare`             | Two to five drugs or trials side by side, with the differing fields                                                         |
| `whats_new`           | Approvals, posted results and status changes since a date, filtered by cancer or target                                     |

The agent composes narrative, comparisons and explanations from these results.

## 7. Operations

- **Hosting.** One server is enough to start: PostgreSQL, the MCP server, and scheduled
  ingestion jobs. Store data size is in the low tens of GB. Staging snapshots go to
  object storage.
- **Freshness.** ClinicalTrials.gov syncs daily. openFDA, EMA and CIViC sync weekly
  (EMA could be nightly). Ontologies sync monthly. Open Targets syncs each release. Every
  response shows the data dates.
- **Authentication and limits.** One API key per Phi account, entered once through the
  connector's `auth: header`. The server enforces per-key rate limits. A server-wide
  openFDA key (120,000 requests a day) covers the live gaps.
- **Privacy.** Query text is not logged beyond short-lived operational logs (for example,
  7 days). Request counts per key are kept for rate limiting. This is stated in the
  connector's description.
- **Quality.** Release gates are schema validation, dangling-ID checks, conflict checks,
  the terms-review age per source, and an evaluation set of 50–100 questions with expected
  answers, run against every release.

### 7.1 Mainland hosting: syncing from US / EU sources

Decision (2026-10-23): the service is hosted in mainland China.

**Measurement.** On 2026-10-23, every source was probed from a mainland residential
connection with the proxy bypassed. Baidu was reachable and Google was not, which
confirms a mainland egress. Bulk files were sampled with a 10 MiB range request. A
data-centre server's international bandwidth can be better or worse than this, so K0
repeats the probe from the chosen host (script: one `curl` per source; the numbers
below are from that run).

| Source                                 | Direct from mainland                       | Sync volume                                                     | Sync time at measured rate           | Verdict                                                    |
| -------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| ClinicalTrials.gov API v2              | OK, 100 full records in 2.3 s (≈ 0.9 MB/s) | 608,228 studies ≈ 13 GB JSON once; daily delta small            | full pull ≈ 4 h; daily delta minutes | OK                                                         |
| openFDA bulk (download.open.fda.gov)   | OK, ≈ 1.8 MB/s                             | Labels 1.77 GB (14 parts); substances 317 MB                    | ≈ 20 min weekly                      | OK                                                         |
| openFDA API                            | OK, slow first byte (≈ 2.7 s)              | Gap filling only                                                | —                                    | OK                                                         |
| Drugs@FDA zip (fda.gov)                | OK, ≈ 1.9 MB/s                             | Tens of MB                                                      | < 1 min                              | OK                                                         |
| precision.fda.gov (UNII archive)       | **HTTP 403, three tries**                  | —                                                               | —                                    | Blocked; use openFDA `other/substance` (includes UNII)     |
| EMA (XLSX / JSON)                      | OK, 0.9 MB file in 3.3 s                   | A few MB                                                        | seconds                              | OK; respect its rate limit (a fast retry got HTTP 429)     |
| CIViC GraphQL                          | OK, < 1 s                                  | Incremental                                                     | —                                    | OK                                                         |
| CIViC nightly TSV                      | Slow, ≈ 25 KB/s                            | Tens of MB                                                      | ≈ 10–20 min                          | Usable; prefer GraphQL for deltas                          |
| NCBI (ClinVar FTP, E-utilities, RxNav) | OK; ClinVar ≈ 0.9 MB/s                     | ClinVar full XML several GB; `variant_summary` ≈ hundreds of MB | ≈ 1–2 h weekly (full XML)            | OK; start with the summary file                            |
| EBI FTP (Open Targets parquet)         | OK, ≈ 0.35 MB/s                            | Association + disease + target tables, a few GB                 | ≈ 2–4 h per release                  | OK; quarterly                                              |
| NCI EVS (NCIt)                         | OK, ≈ 2.7 MB/s                             | Tens of MB                                                      | < 1 min                              | OK                                                         |
| HGNC (Google Cloud Storage)            | OK, ≈ 2.5 MB/s                             | ≈ 15 MB                                                         | seconds                              | OK, but GCS reachability varies over time; keep a fallback |
| OpenAlex, Zenodo (ROR dump)            | OK                                         | ROR dump ≈ hundreds of MB                                       | minutes                              | OK                                                         |
| GitHub (MONDO releases)                | **Timed out every time**                   | ≈ 100–300 MB                                                    | —                                    | Blocked                                                    |

**Conclusion.** All but two of the planned sources sync directly from a mainland host at
workable rates: the largest job (the first ClinicalTrials.gov pull) takes about four
hours once, and the weekly jobs take minutes to a couple of hours. Two sources fail:

- **precision.fda.gov** returns HTTP 403. The same UNII data is in the openFDA substance
  file, which downloads directly.
- **GitHub** is unreachable, which blocks MONDO releases and any other GitHub-hosted
  file.

**How to cover GitHub-hosted files without a cross-border tunnel.** A self-built VPN or
proxy on the server is not compliant for cross-border traffic. Only licensed carriers
may provide cross-border private lines (MIIT, 2017). Options, in order:

1. A small **Hong Kong / overseas fetch node** (for example a cloud VM outside the
   mainland) downloads GitHub-hosted releases on schedule. It verifies checksums and
   publishes them to object storage that the mainland host reads over the ordinary
   internet. The node handles only public files and stores no user data.
2. The cloud provider's licensed cross-border connectivity, if the provider offers it
   for the chosen region.
3. Manual monthly upload (MONDO releases about monthly) as a stopgap until 1 is in place.

Decision (2026-10-23): start with option 3. The overseas node is postponed. An operator
uploads each GitHub-hosted release (MONDO first) to the host's object storage once a
month, together with the upstream release tag and SHA-256. The adapter reads that
location through the same per-source URL and refuses a file whose checksum does not
match. A release whose GitHub-hosted inputs are more than 45 days older than upstream
shows a staleness warning in the release gate (§ 7, Quality).

The overseas node can also serve as the fallback for any source that degrades later.
Ingestion jobs should therefore read every source through a per-source URL that can point
either upstream or at the node's mirror.

**Policy risks on the US side (to confirm with counsel):**

- Since April 2025, NIH blocks access to its **controlled-access** repositories (dbGaP,
  GDC controlled tier) from countries of concern, including China. Open-access data is
  not affected. This design uses only open data.
- The US DOJ data security rule (28 CFR Part 202, in force April 2025) limits US persons
  from giving countries of concern access to bulk US sensitive personal data, including
  human 'omic data. The sources here are aggregate or public records, not individual-level
  genomic data, but counsel should confirm. GDC open-tier individual-level files stay
  deferred.
- US government sites may add geo-blocks without notice (precision.fda.gov already
  does). Each adapter fails loudly, and the overseas node is the fallback.

## 8. Positioning and compliance

- Describe it as **research and translational knowledge**, not diagnosis or treatment
  advice. Tool descriptions and the Database agent's prompt state this. This keeps the
  service outside medical-device software rules (FDA SaMD / CDS, NMPA medical-device
  software), which a clinical decision-support claim could trigger.
- Every response carries the attribution each licence requires (ClinicalTrials.gov, FDA,
  EMA, CIViC citation, MONDO, NCIt, NLM statement for RxNorm).
- Legal review before launch: the ClinicalTrials.gov "international copyright outside the
  US" clause, the EMA "each copy" acknowledgement in an API context, the RxNorm
  keep-current condition, and serving foreign users from a mainland host (cross-border
  data rules).
- Mainland hosting obligations, to confirm with counsel before K2:
  - ICP filing for the service's domain.
  - Graded protection (等保) for the system.
  - Whether serving drug information online needs an **Internet Drug Information
    Service certificate** (互联网药品信息服务资格证书, issued under the NMPA measures for
    internet drug information services). This applies to services that provide drug or
    medical-device information to internet users, and it may cover an API that returns
    drug labels and approvals.

## 9. Decisions needed

1. **Hosting location.** Decided 2026-10-23: mainland China. Direct sync is feasible for
   all but GitHub-hosted files and precision.fda.gov, which § 7.1 covers. GitHub-hosted
   files are uploaded by hand each month; the overseas fetch node is postponed.
2. **Scope of the first release.** Oncology only (recommended), or all diseases. The data
   model is disease-agnostic, so expanding later is mostly curation work.
3. **Domain reviewers.** Curated facts (§ 5) need at least one person with oncology or
   regulatory background to approve pull requests. Without one, the service should ship
   with automatic ingestion only (K1–K2).
4. **Relation to the local live connector.** Either drop C1–C4 from the
   [cancer/clinical plan](../roadmap/data-access-cancer-clinical-connector.md) and rely on
   BioMCP plus this service (recommended), or keep C1 for users who do not want a hosted
   service.
5. **Access model.** Free API key for every Phi account, or tied to a paid plan.

## 10. Steps

| Step | Scope                                                                                                                                                                                                                                                                      | Done when                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| K0   | Decisions in § 9; mainland server, with the § 7.1 probe re-run from it; monthly manual-upload procedure for GitHub-hosted files (§ 7.1); terms re-check for every source in § 4 (ClinVar and ROR first-hand); legal review list, including the mainland obligations in § 8 | Decisions recorded; the source registry has a terms-check date for every row              |
| K1   | Store schema, ID crosswalk (HGNC, MONDO, NCIt, UNII, RxNorm NLM content), adapters for ClinicalTrials.gov, openFDA and CIViC; `resolve`, `drug_profile`, `trials_query`, `biomarker_landscape`                                                                             | A rebuild from staging is reproducible; the first 30 evaluation questions pass            |
| K2   | MCP server on the host, API keys, rate limits; Phi connector package (`transport: http`, `auth: header`), attached to the Database agent                                                                                                                                   | Installs from the catalog and answers through the Database agent only                     |
| K3   | EMA, Open Targets scores, ClinVar; `approvals_query`, `target_landscape`, `compare`, `whats_new`                                                                                                                                                                           | Evaluation questions on regulatory and target topics pass                                 |
| K4   | Curated fact repo and CI; NMPA and PMDA approvals; modality taxonomy; trial aliases                                                                                                                                                                                        | Curated records validate in CI and merge into a release; conflict checks block mismatches |
| K5   | Agent-assisted extraction: standard of care, pivotal efficacy, ADC attributes, biomarker cut-offs; `standard_of_care`                                                                                                                                                      | Every extracted fact has a citation and a reviewer; the full evaluation set passes        |
| K6   | Monitoring, staleness review queue, terms re-check schedule, privacy statement                                                                                                                                                                                             | A release fails automatically on stale terms or stale curated facts                       |
