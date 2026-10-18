# Interface localization

Phi supports English (`en`) and Simplified Chinese (`zh-CN`). With no valid saved
choice, the primary system language determines the default: Chinese language
variants use Simplified Chinese; other or unavailable languages use English. The
main process reads Electron's preferred system languages before showing the
startup splash; the renderer uses the browser's system language for first paint.

The interface language is selected under Settings → Appearance and persists as
`uiLanguage` through the existing application settings API. A valid manual choice
always wins over system detection. Unrelated settings saves do not persist the
detected default as a manual choice. Invalid updates are rejected. Model and
conversation languages are independent of this preference.

## Runtime and copy ownership

`src/renderer/src/lib/i18n.ts` owns the renderer language store. It caches the
preference for first paint, updates the document language and notifies subscribers.
The settings file remains authoritative. A failed save restores the previous
language; stale startup reads or earlier saves cannot overwrite a newer selection.

Use `defineCopy(english, chinese)` for feature-owned semantic dictionaries. The
Chinese dictionary must have the same typed keys and formatter arguments. Shared
resource copy lives in `lib/resourceUi.ts`; feature-specific text stays beside its
feature. English source text is the fallback for an unavailable translation.

Every component rendering localized copy subscribes with `useUiLanguage()`,
including memoized components. `getUiLocale()` supplies the display locale to
date and number formatters. Standard MUI component defaults follow the same
language. The startup splash, native dialogs and macOS tray menu read the saved
preference too. Native copy stays in `src/main/native-ui-copy.ts` so the main
process does not import the renderer's React localization store.

## Live switching and state

- Keep component identity stable. A language selection changes displayed copy,
  not workspace tabs, conversation state, modal state or drafts.
- Module-level labels use getters or render-time builders. A saved formatter
  returned by `defineCopy` remains live, but a string formatted once does not.
- Include the language in memo dependencies when a memo stores localized output.
  Keep raw-data and controller caches independent of language.
- Editors reconfigure language phrases and appearance through compartments.
  Preserve their view instance, unsaved content, selection and undo history.
- Store stable identifiers in filters and confirmations. Both Chinese and English
  category/source aliases remain searchable after switching.

## Data boundaries

Localize app-owned headings, actions, placeholders, accessibility labels, statuses,
confirmation text and generated UI drafts. Preserve author titles/descriptions,
user names and input, notebook/file contents, raw service output and diagnostics.

Resource/model IDs, authentication and transport values, paths, commands, tool
names and semantic palette keys such as `primary` and `warning` are data. Their
values stay unchanged in every language. Display text must never become a key
used by authorization, state classification or execution.

## Verification

Exercise both languages and switching after modules have already loaded. Verify
saved copy references, memoized headings, active confirmations, search state and
restart persistence. Editor changes require a mounted regression that preserves
the editor instance, draft, cursor and undo history. The existing renderer test
uses an isolated profile and never opens or modifies the user's Phi data.

Resource-specific source/trust rules remain in
[resource-ui-language.md](resource-ui-language.md).
