import { useCallback, useMemo, useState } from 'react'

export interface BusyKeys {
  /** Whether this entry has an install, update or removal in flight. */
  has: (key: string) => boolean
  /** Whether anything at all is in flight. */
  any: boolean
  start: (key: string) => void
  finish: (key: string) => void
}

/** Tracks in-flight work per catalog entry, so one running install never locks the other rows. */
export function useBusyKeys(): BusyKeys {
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set())
  const start = useCallback((key: string): void => {
    setKeys((current) => new Set(current).add(key))
  }, [])
  const finish = useCallback((key: string): void => {
    setKeys((current) => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }, [])
  const has = useCallback((key: string): boolean => keys.has(key), [keys])
  return useMemo(
    () => ({ has, any: keys.size > 0, start, finish }),
    [has, keys.size, start, finish]
  )
}
