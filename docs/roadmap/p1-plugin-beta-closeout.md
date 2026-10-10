# P1 Pi Plugin Surface Closeout (Superseded)

Date: 2026-09-06
Superseded: 2026-10-10

The original internal-beta slice exposed the global Pi package catalog as
"Developer extensions" and routed list/install/remove through Phi IPC. Product
review found that this implied project-level integration that the surface did
not provide: there was no project-scoped enablement, live-session lifecycle, or
callable Phi contract, and the chat reference only inserted descriptive text.

The user-facing page, chat reference, and `plugins:list/install/remove` bridge
were therefore removed. OMP still discovers extensions configured outside Phi,
so existing runtime compatibility is preserved. A future management surface
must first define and test project scope, enablement, session refresh behavior,
and an end-to-end callable integration. User-facing "plugin" continues to mean
Phi plugin.
