// The one desktop-side OMP pin. Change together with package.json, the runtime manifest
// checksums and RPC_BOOTSTRAP_OMP_VERSION (self-contained in the remote extension bundle);
// tests/omp-version-pin.test.ts fails when any of them disagree.
export const PINNED_OMP_VERSION = '18.10.3'
