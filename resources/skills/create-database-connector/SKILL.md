---
name: create-database-connector
description: Create, extend, debug, or audit Phi biological database connectors, domains, adapters, record normalization, and connector tests. Use for integrating a database API or repairing connector behavior; do not use for ordinary record lookup, literature synthesis, pipeline execution, or bulk download.
---

# Create Database Connector

Build one reliable vertical slice of biological database access at a time. A slice is complete only when its request contract, response mapping, identity/provenance, policy behavior, offline tests, and a bounded official-API check agree.

## Scope

Work inside Phi's database connector core:

- `resources/db-connectors/<protocol>/<database>/connector.yaml`
- `src/main/agent/db/`
- `src/shared/dbConnectorTypes.ts`
- `tests/db-connector.test.ts`
- `tests/db-connector-live.test.ts`

Do not add database UI, MCP servers, plugin surfaces, download executors, or wrapper packages unless the task explicitly asks for them. Simple JSON, XML, text, FASTA, and flat-file retrieval belongs in the connector or adapter. Dedicated transfer programs such as SRA Toolkit may later be exposed through wrappers, but they are not part of connector retrieval.

## Start Here

1. Read the existing connector manifest, relevant adapter, and nearby tests before editing.
2. Check the database's current official API documentation. Record the exact method, path, required/optional parameters, pagination contract, response shape, rate limits, release/build semantics, and identifier namespaces.
3. Choose the existing protocol family and adapter whenever it can express the endpoint:
   - NCBI E-Utilities metadata and fetches: `entrez` and `EntrezAdapter`.
   - Ordinary JSON REST endpoints: `rest-json` and `RestJsonAdapter`.
   - UniProt asynchronous mapping or entry-format behavior: existing `UniProtAdapter`.
   - Graph queries: `sparql` and `SparqlAdapter`.
4. Add a new adapter or protocol family only when the current request/response contract genuinely cannot represent the API.

Before changing a manifest or adapter, read [references/connector-contract.md](references/connector-contract.md).

## Vertical-Slice Rule

Finish one database or coherent endpoint family before moving to another. Do not equate a long endpoint list with completeness.

For every added domain, prove:

- required inputs fail locally when absent;
- unknown, duplicate, or unsupported inputs do not become ambiguous upstream requests;
- GET/POST path, query parameters, headers, and body match official documentation;
- response rows map to declared fields without silent empty objects;
- pagination terminates, preserves the next cursor at bounds, and detects repeated cursors;
- stable identity is declared only for a real entity with a fixed namespace;
- source database/domain and provenance survive field projection;
- network hosts, redirects, retries, caching, timeout, and response-size policies remain enforced;
- a real bounded query succeeds against the official API.

## Manifest First

Prefer manifest-only domains when the generic adapter is sufficient. Keep request inputs explicit through path templates, parameter maps, or JSON body maps. Do not rely on permissive pass-through parameters.

Declare output fields accurately:

- `commonFields` lists the useful normalized response surface.
- `fields` supplies type, description, synonyms, and namespace where known.
- `identity` is optional. Add it only when each returned row represents one stable entity and the namespace is fixed.
- Relationship rows, coordinate mappings, search echoes, multi-ID translations, health checks, and dynamic-namespace xrefs usually must not declare identity.

Never invent an identifier, organism, assembly, release, namespace, or primary URL. If a mapping is uncertain, preserve the source value and report the uncertainty.

## Adapter Changes

Change an adapter only when the manifest cannot express required behavior such as asynchronous jobs, multi-request enrichment, text resource composition, or database-specific normalization.

- Keep API traffic inside the adapter and `executeDbHttpRequest` policy boundary.
- Reuse shared query-window, field-validation, record-normalization, result-writing, and provenance helpers.
- Parse structured JSON/XML instead of extracting biological data with fragile text slicing when a maintained parser or existing structured helper is available.
- Keep direct text resources as fields or download candidates; do not create a wrapper for a small one-record text response.
- Keep GEO/SRA transfer behavior at manifest/URL/command-plan level unless the user separately requests download execution.

## Tests

Add regression tests before or with the implementation:

1. Manifest validation and request rendering.
2. Mock official response normalization, including missing/optional fields.
3. Invalid input, unsupported operation, pagination, retry, policy, and projection behavior.
4. Identity assertions that prove both positive and intentionally absent identity cases.
5. A stable real-API smoke query in `tests/db-connector-live.test.ts`.

Use live-test tiers:

- `PHI_DB_LIVE_TESTS=1`: small stable smoke coverage.
- `PHI_DB_LIVE_TESTS=expanded`: slower endpoint families, asynchronous jobs, or fragile upstream services.

Never make ordinary offline tests depend on the network. Avoid asserting volatile descriptions or counts in live tests; assert stable IDs, response shape, namespaces, and invariant fields.

## Verification

Run at least:

```bash
node --import ./scripts/test-loader.mjs --test tests/db-connector.test.ts
npm run typecheck
npx eslint src/main/agent/db src/shared/dbConnectorTypes.ts tests/db-connector.test.ts tests/db-connector-live.test.ts
git diff --check -- src/main/agent/db src/shared/dbConnectorTypes.ts tests/db-connector.test.ts tests/db-connector-live.test.ts resources/db-connectors
```

Run the relevant live tier with network permission before claiming the endpoint works. For a broad adapter change, run both NCBI/UniProt/Ensembl smoke coverage and the affected expanded test.

## Completion Report

State exactly:

- which database/domain families are implemented;
- which inputs, response fields, pagination, identities, and download candidates are covered;
- which official live requests were run and their outcome;
- tests/typecheck/lint results;
- unsupported or intentionally deferred behavior.

Do not say a database is fully integrated merely because its manifest parses or mocked tests pass.
