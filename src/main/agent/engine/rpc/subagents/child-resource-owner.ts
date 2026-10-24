import type { RpcChildRun } from './run-registry'
import type { RpcChildRuntimeConfig } from '../../phi-extension/lib/rpc-child-config'

export function childResourceOwner(
  run: RpcChildRun | undefined,
  config: Readonly<RpcChildRuntimeConfig> | undefined
): { readonly toolOwner: string; readonly allowedSkills: readonly string[] } {
  const profile =
    run && config?.profiles.find((entry) => entry.definition.nativeName === run.scope.nativeName)
  if (!profile) throw new Error('Child resource owner is unavailable')
  return Object.freeze({
    toolOwner: profile.definition.phiName,
    allowedSkills: Object.freeze([...profile.definition.skills])
  })
}
