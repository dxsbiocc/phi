import { discoverAuthStorage } from '@oh-my-pi/pi-coding-agent'

import { createModelAccessBroker, type ModelAccessBroker } from './model-access-broker'

export interface DesktopModelAccessOwner {
  readonly broker: ModelAccessBroker
  close(): void
}

export async function createDesktopModelAccessOwner(
  agentDir: string
): Promise<DesktopModelAccessOwner> {
  const storage = await discoverAuthStorage(agentDir)
  return {
    broker: createModelAccessBroker(storage),
    close: () => storage.close()
  }
}
