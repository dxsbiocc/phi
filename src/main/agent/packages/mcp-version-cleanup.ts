import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { describeMcpPackageEnvironment } from '../mcp/package-environment'
import { hasLiveEnvironmentLeases } from '../envs/leases'
import { tryAcquireEnvironmentLock } from '../envs/lock'
import { readPackageManifest } from './manifest'
import { mcpPackagesDir, readMcpPackagesRegistry } from './mcp-store'
import type { InstallerOptions } from './installer-types'

/** Old source versions remain alongside their leased runtime until consumers disconnect. */
export function cleanupInactiveMcpVersions(
  agentDir: string,
  runtimeRoot: string,
  options: Pick<InstallerOptions, 'environmentsDir' | 'platform'> = {}
): string[] {
  const base = mcpPackagesDir(agentDir)
  if (!existsSync(base)) return []
  const active = readMcpPackagesRegistry(agentDir)
  const removed: string[] = []
  for (const owner of readdirSync(base, { withFileTypes: true })) {
    if (!owner.isDirectory() || !/^[a-z][a-z0-9-]{1,63}$/.test(owner.name)) continue
    const root = join(base, owner.name)
    for (const version of readdirSync(root, { withFileTypes: true })) {
      if (
        !version.isDirectory() ||
        !semver.valid(version.name) ||
        active.packages[owner.name]?.version === version.name
      )
        continue
      const dir = join(root, version.name)
      let lock: ReturnType<typeof tryAcquireEnvironmentLock> | undefined
      try {
        const manifest = readPackageManifest(dir)
        if (
          manifest.type !== 'mcp' ||
          manifest.id !== owner.name ||
          manifest.version !== version.name
        )
          continue
        const environment = describeMcpPackageEnvironment(manifest, dir, { ...options, agentDir })
        if (environment) {
          lock = tryAcquireEnvironmentLock(runtimeRoot, environment.envId)
          if (!lock || hasLiveEnvironmentLeases(runtimeRoot, environment.envId)) continue
        }
        if (readMcpPackagesRegistry(agentDir).packages[owner.name]?.version === version.name)
          continue
        rmSync(dir, { recursive: true, force: true })
        removed.push(`${owner.name}@${version.name}`)
      } catch {
        // Unknown or broken content is never treated as an owned disposable version.
        continue
      } finally {
        lock?.release()
      }
    }
  }
  return removed.sort()
}
