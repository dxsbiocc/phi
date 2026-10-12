# GitHub connector sources

Date: 2026-10-11

Phi may import a public `https://github.com/<owner>/<repo>` repository as a connector
catalog source. The source is resolved to and stored at an immutable commit SHA. Branches
are consulted again only when the user explicitly checks for an update; Phi presents the
package-version diff and switches snapshots only after confirmation.

- GitHub imports always carry `imported` trust and are presented as unsigned. They do not
  add trusted signing keys or extend the official Phi registry trust boundary.
- Version 1 supports public repositories on `github.com` only and imports `type: mcp`
  packages only. Private repositories, tokens, other forges, arbitrary repositories, and
  non-MCP installation are outside this decision.
- Preview and source registration parse bounded archives, validate package manifests, and
  materialize a local registry. They execute no repository code, run no environment build,
  and install nothing. The existing connector installer remains the only installation path.
- Source records live in `~/.phi/state/github-sources.json`, separate from the older
  directory-source `registries.json`, so older builds never encounter an unknown registry
  kind. Cached snapshots live under the validated owner/repository/SHA path.
- Removing a source removes its managed cache only. Installed packages remain under
  `~/.phi/packages` and continue to work independently of their former catalog source.
