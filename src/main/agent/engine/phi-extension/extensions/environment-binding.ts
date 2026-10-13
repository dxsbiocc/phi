import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import type { PhiExtensionHost } from '../host'
import { rewriteBoundBashInput, type EnvironmentBinding } from '../lib/environment'

export function createEnvironmentBindingExtension(
  source: PhiExtensionHost | EnvironmentBinding
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', (event) => {
      if (event.toolName !== 'bash') return undefined
      let binding: EnvironmentBinding | undefined
      let hostEnvironment: Readonly<Record<string, string | undefined>> | undefined
      if (isExtensionHost(source)) {
        binding = source.environmentBinding()
        hostEnvironment = source.hostEnvironment()
      } else {
        binding = source
        hostEnvironment = source.hostEnv
      }
      if (!binding) return undefined
      const input = rewriteBoundBashInput(event.input, binding, hostEnvironment)
      return input ? { input } : undefined
    })
  }
}

function isExtensionHost(value: PhiExtensionHost | EnvironmentBinding): value is PhiExtensionHost {
  return typeof (value as Partial<PhiExtensionHost>).environmentBinding === 'function'
}
