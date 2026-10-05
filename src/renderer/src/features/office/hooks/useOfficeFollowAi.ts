import { useCallback, useEffect, useState } from 'react'

import type { OfficePreviewDocument } from '../../../../../shared/officeProtocol'
import { getRendererApi } from '../../../lib/rendererApi'
import {
  readOfficeFollowAiPreference,
  writeOfficeFollowAiPreference
} from '../lib/officeFollowPreference'

export interface OfficeFollowAiState {
  readonly controllable: boolean
  readonly enabled: boolean
  readonly setEnabled: (enabled: boolean) => void
}

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function pageVisible(): boolean {
  return globalThis.document.visibilityState === 'visible'
}

export function useOfficeFollowAi(
  officeDocument: OfficePreviewDocument | null
): OfficeFollowAiState {
  const [enabled, setEnabledState] = useState(() => readOfficeFollowAiPreference(browserStorage()))
  const bridge = getRendererApi().office
  const controllable =
    officeDocument?.followAiControllable === true &&
    officeDocument.kind !== 'docx' &&
    officeDocument.kind !== 'pptx' &&
    typeof bridge.setPreviewPreferences === 'function'

  useEffect(() => {
    if (!officeDocument || !controllable || !bridge.setPreviewPreferences) return
    const publish = (visible: boolean): void => {
      void bridge.setPreviewPreferences!({
        artifactId: officeDocument.artifactId,
        visible,
        followAi: enabled
      }).catch(() => undefined)
    }
    const onVisibilityChange = (): void => publish(pageVisible())
    publish(pageVisible())
    globalThis.document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      globalThis.document.removeEventListener('visibilitychange', onVisibilityChange)
      publish(false)
    }
  }, [bridge, controllable, enabled, officeDocument])

  const setEnabled = useCallback((next: boolean): void => {
    writeOfficeFollowAiPreference(browserStorage(), next)
    setEnabledState(next)
  }, [])
  return { controllable, enabled, setEnabled }
}
