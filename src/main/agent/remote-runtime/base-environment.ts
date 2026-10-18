import { describeEnvironment } from '../content/environment-refs'
import { parseEnvironmentRef } from '../envs'

export async function resolveRemoteBaseEnvironment(
  ref: string,
  pluginId: string | undefined,
  agentDir: string
): Promise<{ packages: readonly string[]; channels: readonly string[] }> {
  const parsed = parseEnvironmentRef(ref)
  if (parsed.kind === 'project') {
    throw new Error(
      'Remote env_request cannot safely read local project environment declarations. Use a phi: base environment, or build on a machine with network access and transfer it. No fallback to the local project directory was used.'
    )
  }
  if (parsed.kind === 'plugin' && !pluginId) {
    throw new Error(
      'The remote main session cannot determine which plugin owns a plugin: environment. Call env_request in the corresponding plugin specialist session, or use a phi: base environment. No local fallback was used.'
    )
  }
  const descriptor = describeEnvironment(ref, {
    agentDir,
    ...(pluginId ? { pluginId } : {})
  })
  if (descriptor.spec.dependencies.some((dependency) => typeof dependency !== 'string')) {
    throw new Error(
      'Remote env_request does not yet support base environments with pip dependencies. Build on a machine with network access and transfer the environment.'
    )
  }
  if (descriptor.spec.sourcePackages?.length) {
    throw new Error(
      'Remote env_request does not yet support base environments requiring additional source packages. Build on a machine with network access and transfer the environment. No local fallback was used.'
    )
  }
  return {
    packages: descriptor.spec.dependencies as string[],
    channels: descriptor.spec.channels
  }
}
