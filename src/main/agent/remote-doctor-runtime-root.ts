import type { RemoteDoctorOptions } from '../../shared/remoteDoctorTypes'
import type { ResolvedRemoteRuntimeRoot } from '../../shared/remoteRuntimeRootTypes'
import { DEFAULT_REMOTE_RUNTIME_ROOT, resolveRemoteRuntimeRoot } from './remote-runtime-root'

export function selectedRemoteDoctorRuntimeRoot(
  options: RemoteDoctorOptions,
  hostOverride: string | undefined
): ResolvedRemoteRuntimeRoot {
  const override = options.runtimeRootOverride
  const input =
    override?.source === 'project'
      ? { projectOverride: override.configured, hostOverride }
      : { hostOverride: override?.source === 'host' ? override.configured : hostOverride }
  try {
    return resolveRemoteRuntimeRoot(input)
  } catch {
    return {
      source: override?.source ?? 'default',
      configured: override?.configured ?? DEFAULT_REMOTE_RUNTIME_ROOT
    }
  }
}
