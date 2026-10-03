import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import {
  ExtensionRuntime,
  loadExtensionFromFactory
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/loader'
import { EventBus } from '@oh-my-pi/pi-coding-agent/utils/event-bus'

type SpecialistSession = {
  extensionRunner?: { hasHandlers(eventType: string): boolean }
  dispose(): Promise<void>
}

const installationError = (): Error => new Error('specialist tool guards could not be installed')

/** Install guards omitted by omp's restrictToolNames path, failing the session closed. */
export async function installSpecialistToolCallExtensions(
  session: SpecialistSession,
  factories: readonly ExtensionFactory[],
  cwd: string
): Promise<void> {
  try {
    const runner = session.extensionRunner
    if (!runner) throw installationError()
    if (runner.hasHandlers('tool_call')) return
    const extensions = (runner as { extensions?: unknown }).extensions
    if (!Array.isArray(extensions)) throw installationError()
    const runtime = new ExtensionRuntime()
    const eventBus = new EventBus()
    for (let index = 0; index < factories.length; index += 1) {
      const factory = factories[index]
      if (!factory) continue
      extensions.push(
        await loadExtensionFromFactory(factory, cwd, eventBus, runtime, `<phi-specialist-${index}>`)
      )
    }
    if (!runner.hasHandlers('tool_call')) throw installationError()
  } catch (error) {
    await session.dispose()
    throw error
  }
}
