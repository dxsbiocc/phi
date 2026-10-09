import { describeEnvironment, type EnvironmentDescriptor } from '../content/environment-refs'
import { computeEnvId, lockSha256, type PhiPlatform } from '../envs'
import type { McpPackageManifest } from '../packages/manifest'

export interface McpEnvironmentLookupOptions {
  agentDir?: string
  environmentsDir?: string
  platform?: PhiPlatform
}

export interface McpEnvironmentRecord {
  descriptor: EnvironmentDescriptor
  envId: string
  name: string
  kind: 'base' | 'package' | 'project'
  platform: PhiPlatform
  lockSha256: string
}

export function describeMcpPackageEnvironment(
  manifest: McpPackageManifest,
  packageDir: string,
  options: McpEnvironmentLookupOptions = {}
): McpEnvironmentRecord | undefined {
  if (manifest.connector.transport !== 'stdio') return undefined
  const descriptor = describeEnvironment(manifest.connector.environment, {
    agentDir: options.agentDir,
    environmentsDir: options.environmentsDir,
    platform: options.platform,
    mcpPackage: { id: manifest.id, dir: packageDir }
  })
  const envId = computeEnvId({
    scope: descriptor.scope,
    owner: descriptor.owner,
    name: descriptor.spec.name,
    platform: descriptor.platform,
    lockText: descriptor.lockText,
    sourcePackages: descriptor.spec.sourcePackages,
    installation: descriptor.spec.installation
  })
  return {
    descriptor,
    envId,
    name: descriptor.spec.name,
    kind: descriptor.kind,
    platform: descriptor.platform,
    lockSha256: lockSha256(descriptor.lockText)
  }
}
