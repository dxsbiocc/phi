# Frontend Feature Boundaries

Phi's renderer uses feature folders for page-level functionality. This keeps large surfaces readable, gives tests stable boundaries, and prevents shared directories from becoming a dumping ground.

## Rule Of Thumb

Build pages as features, not as loose components.

```text
src/renderer/src/features/<feature>/
  <Feature>View.tsx
  components/
  lib/
  hooks/
```

Use `src/renderer/src/components` only for reusable UI shared by at least two features. Use `src/renderer/src/lib` only for cross-feature logic or application-level infrastructure.

For embedded surfaces that are not full pages, use the most accurate root entry name, for example `<Feature>Panel.tsx`.

## Current Examples

- `src/renderer/src/features/analysis/AnalysisView.tsx`
- `src/renderer/src/features/analysis/components/`
- `src/renderer/src/features/analysis/lib/`
- `src/renderer/src/features/analysis/notebook/`
- `src/renderer/src/features/runtime/RuntimeView.tsx`
- `src/renderer/src/features/runtime/lib/`
- `src/renderer/src/features/file-preview/FilePreviewPanel.tsx`
- `src/renderer/src/features/file-preview/components/`

The `analysis/notebook` folder is intentionally feature-local. It is not a global notebook framework until another feature actually reuses it.

## What To Do When Adding A Page

1. Create `src/renderer/src/features/<feature>/<Feature>View.tsx` for a page, or `<Feature>Panel.tsx` for an embedded surface.
2. Put private child components under `features/<feature>/components/`.
3. Put feature-only helpers under `features/<feature>/lib/`.
4. Put feature-only hooks under `features/<feature>/hooks/`.
5. Export/import the view from the app shell.
6. Add tests that import through the feature path.

Do not add a new page-level `*View.tsx` file to `src/renderer/src/components`.

## What To Do When Editing Legacy Pages

Some legacy pages still live in `src/renderer/src/components`. When touching one substantially, prefer migrating it into a feature folder first, then make the behavior change inside that feature boundary.

Keep migrations small:

- Lock behavior with targeted tests first.
- Move the page and its private helpers together.
- Update imports without changing behavior.
- Run `npm run check:architecture`, targeted tests, lint, and typecheck.

## Size Guidance

- Under 600 lines: keep it together if cohesive.
- 600 to 1000 lines: explicitly decide whether to split by responsibility.
- Over 1000 lines: treat as architecture debt unless there is a documented temporary reason.

The goal is not to split for its own sake. The goal is that future agents can quickly answer: "Where does this feature live, what is private to it, and what is genuinely shared?"

## Automated Check

Run:

```sh
npm run check:architecture
```

The check blocks new page-level views in the shared `components` directory and flags oversized non-legacy files. `npm run lint` runs this check before ESLint.
