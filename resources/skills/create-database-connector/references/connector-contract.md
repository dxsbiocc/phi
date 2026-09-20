# Phi Database Connector Contract

Read this reference when creating or changing a connector manifest, adapter, or connector test.

## Manifest Shape

Every connector declares:

- `phiDbConnectorVersion: 1`
- canonical `id`, name, protocol family, curation tier, HTTPS base URL;
- allowed network hosts and redirect policy;
- authentication metadata without credentials;
- rate and retry policy;
- one or more domains;
- optional cross-reference hints.

Trust tier, install path, digest, and query-enabled state come from Phi storage, not `connector.yaml`.

## REST Request Mapping

`rest.request` supports:

- `path` with `{filter:<field>}`, `{rawQuery}`, `{limit}`, or `{cursor}` tokens;
- `method: GET | POST`;
- explicit idempotency for safe POST searches;
- fixed `queryParams`;
- `filterParamMap` for declared query-string inputs;
- `jsonBodyParamMap` for POST body keys;
- `jsonBodyArrayFields` and `jsonBodyOptionalFields` using body-key names;
- `rawQueryParam`, `limitParam`, and `cursorParam`.

Required path and non-optional body filters must fail before network access. Do not add a generic unlisted filter fallback. Use the exact singular/plural parameter names from official documentation.

## REST Response Mapping

`rest.response` supports:

- `rowsPath`
- `totalRowsPath`
- `nextCursorPath`
- `fieldMap`

Paths use a bounded JSON-path subset: dot properties, numeric array indexes, and `*` wildcards over arrays or object values. Use nested wildcards for payloads such as an array of allele-keyed objects. Confirm the mapped row is the biological entity, not merely an enclosing result or relationship object.

## Domains And Fields

Each domain has:

- normalized `id` and concise `summary`;
- `commonFields` matching actual normalized output;
- optional typed `fields` metadata;
- protocol-specific request/response mapping;
- optional `identity`.

Requested output fields are strict. If the adapter emits a useful normalized field, declare it. If the API response changed, update normalization and tests instead of silently returning empty projected rows.

## Identity

Identity is explicit:

```yaml
identity:
  stableIdFields: [accession, uid]
  namespace: example.accession
  primaryUrlTemplate: https://example.org/record/{stable_id}
```

Rules:

- Every `stableIdFields` entry must be declared by the domain.
- Fallback order is left to right.
- The namespace must describe every selected fallback field. Split domains or omit ambiguous fallbacks when it does not.
- URL templates use HTTPS and only `{stable_id}`.
- Do not assign identity to rows with multiple candidate IDs, mixed feature namespaces, relationships, mappings, aggregations, or service metadata.

Standard record fields are `source_database`, `source_domain`, `stable_id`, `stable_id_namespace`, and `primary_url`. They survive field projection when available.

## Pagination

Adapter `limit` is an integer from 1 through 500. Offset cursors are non-negative integers; opaque cursors must be non-empty. `db_query` defaults to one page and permits at most 10 explicitly requested pages.

Return:

- `truncated: false` when the source is exhausted;
- `truncated: true` plus `nextCursor` when more rows remain;
- upstream `totalRows` when authoritative;
- aggregated attempts/retry state and `pagesFetched` for multi-page retrieval.

Repeated cursors are an error, not a reason to loop.

## Download Candidates

Rows may expose `download_urls` and structured `download_files`. Include stable accession, URL, format, availability, source, and checksum/size when the API provides them.

- Direct small text/JSON/XML/FASTA resources remain connector resources.
- Directory listings and inferred conventional filenames are candidates, not guaranteed files.
- GEO/SRA connectors produce manifests and URLs; they do not execute bulk transfer.
- Dedicated transfer tools belong in wrappers only when that later workflow is explicitly requested.

## Test Matrix

For each endpoint family, cover:

| Layer      | Required evidence                                                |
| ---------- | ---------------------------------------------------------------- |
| Manifest   | parses; invalid host/auth/body/identity contracts fail           |
| Request    | exact method, encoded path, query, body, headers, idempotency    |
| Response   | representative official shape maps to declared fields            |
| Validation | unknown/duplicate fields and invalid operations fail locally     |
| Pagination | first, middle, final, bounded, and repeated-cursor behavior      |
| Policy     | host, redirects, proxy, retries, cache, timeout, size, redaction |
| Identity   | stable ID/namespace/URL positive and intentional-absence cases   |
| Live       | bounded official request with invariant assertions               |

Mock payloads should resemble captured official shapes but contain no secrets or large copyrighted content.
