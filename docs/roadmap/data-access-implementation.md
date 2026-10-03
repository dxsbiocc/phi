# Data Access Implementation Plan

Side track of the [runtime and content distribution plan](content-distribution-implementation.md)
§4. Supersedes the "API skills + core fetch tool" shape of
[content distribution design](../design/phi-content-distribution-design.md) §10.2 (decision
2026-10-03).

## Decisions (2026-10-03)

- **This release removes the database toolchain**: the `db_*` tools, the Database agent,
  `resources/db-connectors/`, the 设置 › 数据库 page, and the database result previews. Public
  database lookups use the main agent's existing URL reading (`read` on a URL), which the
  2026-09-29 evaluation found as accurate as `db_*` at half the latency (design Appendix A).
  The removed implementation is kept at the git tag `db-toolchain-before-removal` as
  reference material.
- **No new generic fetch tool.** HTTP concerns that plain URL reading lacks (POST for
  GraphQL/SPARQL, per-host rate limits, API keys, bulk downloads) belong inside the
  database connectors below.
- **Next release: databases as MCP connectors** (connector contract), split by **source
  family** (about 12–15: NCBI Entrez, UniProt, structures (PDBe/RCSB/AlphaFold), Ensembl,
  pathways (KEGG/Reactome/WikiPathways), chemistry (PubChem/ChEMBL/BindingDB/ZINC),
  variants, expression, interactions, cancer/clinical, literature, ontologies), **written
  in-house** as stdio servers in a managed environment, with small task-shaped tools (not a
  generic query language), used **only by a Database agent** so the main agent's tool list
  does not grow.

## Next release steps

| Step | Scope                                                                                                                                                                                                                                                                                                                             | Done when                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| M1   | Connector contract 1.1.0: `secrets` for stdio servers (stored in the credential store, passed only to that server's process), `attachTo` agent scoping; a shared stdlib-only Python MCP kit (JSON-RPC stdio, HTTP with retry, per-host rate limits, public-address checks, caching); one reference connector (UniProt) end to end | the reference connector installs, runs in its environment, and answers through the Database agent only |
| M2   | Evaluation arm for MCP connectors against plain URL reading, including batch, pagination, GraphQL, SPARQL, and rate-limited tasks                                                                                                                                                                                                 | the eval runs with one command; numbers recorded                                                       |
| M3   | The remaining source-family connectors                                                                                                                                                                                                                                                                                            | each passes its eval tasks                                                                             |
