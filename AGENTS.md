# Phi Project Instructions

- Every 3 assistant turns while implementing this project, review `docs/roadmap/internal-beta-implementation.md` before choosing or continuing work.
- Use that roadmap check to keep scope aligned with the internal beta: prefer small, roadmap-backed increments and avoid unrelated placeholder features, broad migrations, or public-distribution work.
- Mention the roadmap check briefly in progress/final notes when it affects the next implementation choice.

## Frontend Feature Boundary Contract

- Renderer page-level features belong under `src/renderer/src/features/<feature>/`.
- Page-level feature entry files should be named `<Feature>View.tsx` and live at the feature root. Embedded feature surfaces may use precise names such as `<Feature>Panel.tsx`.
- Feature-private UI belongs in `features/<feature>/components/`.
- Feature-private logic belongs in `features/<feature>/lib/`.
- Feature-private hooks belong in `features/<feature>/hooks/`.
- Domain-specific subfolders inside a feature are allowed when they make that feature easier to read, for example `features/analysis/notebook/`.
- `src/renderer/src/components` and `src/renderer/src/lib` are shared layers. Put code there only when at least two features use it, or when it is truly application-level infrastructure.
- Do not add new page-level `*View.tsx` files to `src/renderer/src/components`. Existing legacy views should migrate into feature folders when touched for substantial work.
- Files over 600 lines require an explicit split-or-keep judgment. Files over 1000 lines are architecture debt unless they are documented as temporary legacy exceptions.
- Splitting is for stability, readability, test boundaries, and maintainability. Do not split mechanically when a cohesive file is already small and clear.
- Run `npm run check:architecture` after frontend structure changes; `npm run lint` also runs this check.

See `docs/architecture/frontend-feature-boundaries.md` for examples and migration guidance.
