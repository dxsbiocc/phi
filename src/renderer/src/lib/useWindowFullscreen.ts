import { useEffect, useState } from 'react'
import type { RendererApi } from '../types'

type WindowFullscreenApi = Pick<RendererApi, 'getWindowFullscreen' | 'onWindowFullscreenChanged'>

export function useWindowFullscreen(api: WindowFullscreenApi, enabled: boolean): boolean {
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    if (!enabled) return undefined
    // A dev renderer can hot-reload ahead of an older preload that lacks these methods.
    if (
      typeof api.onWindowFullscreenChanged !== 'function' ||
      typeof api.getWindowFullscreen !== 'function'
    ) {
      return undefined
    }

    let disposed = false
    let receivedEvent = false
    const unsubscribe = api.onWindowFullscreenChanged((nextFullscreen) => {
      if (disposed) return
      receivedEvent = true
      setFullscreen(nextFullscreen)
    })

    void api
      .getWindowFullscreen()
      .then((initialFullscreen) => {
        if (!disposed && !receivedEvent) setFullscreen(initialFullscreen)
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [api, enabled])

  return enabled && fullscreen
}
