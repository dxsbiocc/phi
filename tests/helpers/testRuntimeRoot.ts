import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A runtime root owned by one test file. Test files run in parallel, and some of them
 * garbage-collect or rebuild environments, so they must never share `envs/` or `state/`.
 *
 * With PHI_TEST_RUNTIME_ROOT set (CI, or a developer reusing downloads), the root is a
 * fresh directory under it whose `pkgs/` and `sources/` are symlinks to the shared
 * download caches there; micromamba locks its package cache for concurrent use.
 * Without it, the root is a plain temp directory. Either way the caller removes the root
 * with `removeTree` when done; that removes the symlinks, not the shared caches.
 */
export function createTestRuntimeRoot(name: string): string {
  const shared = process.env.PHI_TEST_RUNTIME_ROOT
  if (!shared) return mkdtempSync(join(tmpdir(), `${name}-`))
  for (const cache of ['pkgs', 'sources', 'roots']) {
    mkdirSync(join(shared, cache), { recursive: true })
  }
  const root = mkdtempSync(join(shared, 'roots', `${name}-`))
  symlinkSync(join(shared, 'pkgs'), join(root, 'pkgs'), 'dir')
  symlinkSync(join(shared, 'sources'), join(root, 'sources'), 'dir')
  return root
}
