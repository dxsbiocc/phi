import { useEffect, useState, useSyncExternalStore } from 'react'
import { MODEL_AVAILABILITY_CHANGED } from '../../../lib/modelAvailabilityEvents'
import {
  ModelAvailabilityController,
  type AvailabilityState
} from '../lib/modelAvailabilityController'

export function useModelAvailability(providerStatusKey: string): {
  state: AvailabilityState
  controller: ModelAvailabilityController
} {
  const [controller] = useState(
    () =>
      new ModelAvailabilityController(
        {
          getModelAvailability: () => window.api.getModelAvailability(),
          setModelEnabled: (change) => window.api.setModelEnabled(change)
        },
        () => window.dispatchEvent(new Event(MODEL_AVAILABILITY_CHANGED))
      )
  )
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  )
  useEffect(() => {
    const dispose = controller.mount()
    const refresh = (): void => {
      void controller.refresh()
    }
    window.addEventListener(MODEL_AVAILABILITY_CHANGED, refresh)
    return () => {
      window.removeEventListener(MODEL_AVAILABILITY_CHANGED, refresh)
      dispose()
    }
  }, [controller])
  useEffect(() => {
    void controller.refresh()
  }, [controller, providerStatusKey])
  return { state, controller }
}
