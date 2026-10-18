# Resource management language

Plugin, Skill, Connector and Wrapper management follow the application-wide
English / Simplified Chinese preference, initially selected from the system
language unless a manual choice is saved. This covers
navigation, catalogs, details, fixed statuses, confirmations, accessible labels
and embedded setup controls. See [ui-localization.md](ui-localization.md) for the
shared runtime, persistence and state-retention contract.

## Copy ownership

- Shared resource terminology and catalog actions live in
  `src/renderer/src/lib/resourceUi.ts`.
- Feature-owned copy lives in `lib/skillCopy.ts`, `lib/pluginCopy.ts`,
  `lib/connectorCopy.ts`, `lib/wrapperCopy.ts` and `lib/remoteSetupCopy.ts` under the
  relevant feature. Use semantic keys and functions for interpolated values.
- Shared controls subscribe to the same interface language as their callers.
- App-owned backend status and error messages default to English. Server output
  and third-party diagnostics remain available in their original form.

Additional locales implement the same semantic copy keys and select their
dictionary at the display boundary. Language changes preserve resource selection,
queries, pagination, pending approvals and installed resources.

## Resource data is not UI copy

Resource IDs, package versions, tool names, transport/authentication values and
persisted category/filter keys remain stable. Existing raw Chinese values are
retained for compatibility; a translated label must never become an identifier.

Known official category and source labels can be translated for display and
search. Unknown custom labels, author titles/descriptions, user input, file paths,
commands and external service responses remain unchanged. Search accepts the
original known category label as well as its English presentation.

Trust badges describe verification state independently of language. In particular,
an official website source does not become signature-verified merely because its
label is displayed in English.
