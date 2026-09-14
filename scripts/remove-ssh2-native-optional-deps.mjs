import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `ssh2` declares `cpu-features` (and its build dependency `nan`) as
 * optional native addons for hardware-accelerated crypto — `ssh2` already
 * falls back to its pure-JS crypto path via try/catch when they're absent
 * (see remote-ssh-session.ts's module doc comment / the packaging notes in
 * docs). They cause a real, reproducible packaging failure though:
 * `cpu-features`'s own `install` script generates a `buildcheck.gypi` file
 * before running `node-gyp rebuild`
 * (node_modules/cpu-features/package.json: `"install": "node buildcheck.js
 * > buildcheck.gypi && node-gyp rebuild"`), but bun doesn't run that script
 * (cpu-features/nan aren't in this repo's `trustedDependencies`), so
 * `buildcheck.gypi` never gets generated. `electron-builder install-app-deps`
 * (via `@electron/rebuild`) then calls `node-gyp rebuild` on the
 * already-installed module directly — skipping npm lifecycle scripts
 * entirely — and fails with "gyp: buildcheck.gypi not found", since
 * `binding.gyp` requires that generated file. electron-builder has no
 * config knob to exclude a single module from its native rebuild pass, so
 * the reliable fix is removing these two packages before that rebuild runs
 * — not trusting their install scripts and hoping the native build
 * succeeds on every platform this app ships to.
 */
const root = process.cwd()
const packagesToRemove = ['cpu-features', 'nan']

for (const name of packagesToRemove) {
  const path = join(root, 'node_modules', name)
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true })
    console.log(
      `Removed node_modules/${name} (ssh2's optional native crypto accelerator — unused, breaks electron-builder install-app-deps).`
    )
  }
}
