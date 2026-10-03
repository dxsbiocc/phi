import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  if (!shared) {
    const root = mkdtempSync(join(tmpdir(), `${name}-`))
    seedSourceArchives(root)
    return root
  }
  for (const cache of ['pkgs', 'sources', 'roots']) {
    mkdirSync(join(shared, cache), { recursive: true })
  }
  const root = mkdtempSync(join(shared, 'roots', `${name}-`))
  symlinkSync(join(shared, 'pkgs'), join(root, 'pkgs'), 'dir')
  symlinkSync(join(shared, 'sources'), join(root, 'sources'), 'dir')
  seedSourceArchives(root)
  return root
}

const SOURCE_ARCHIVES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'source-archives'
)

/**
 * Pre-fill `<root>/sources/` with the pinned R source archives the fixtures use (named by
 * sha256, the cache layout). Installs still verify each digest; this only removes the
 * dependence on CRAN and GitHub being reachable, which made the R tests flaky. Download
 * behaviour itself is covered by unit tests with an injected downloader.
 */
export function seedSourceArchives(root: string): void {
  const sources = join(root, 'sources')
  mkdirSync(sources, { recursive: true })
  for (const name of readdirSync(SOURCE_ARCHIVES)) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue
    const target = join(sources, name)
    if (!existsSync(target)) copyFileSync(join(SOURCE_ARCHIVES, name), target)
  }
}
