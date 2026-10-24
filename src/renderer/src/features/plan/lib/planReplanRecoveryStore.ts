import type { PendingReplanCancellation } from './planReplanDelivery'

// Backend replan requests live only in this app process. Keep failed cleanup
// visible across panel remounts and session navigation.
const requests = new Map<string, PendingReplanCancellation>()
const listeners = new Set<() => void>()
let revision = 0

export const planReplanRecoveryStore = {
  get(key: string): PendingReplanCancellation | undefined {
    return requests.get(key)
  },
  set(key: string, pending: PendingReplanCancellation): void {
    requests.set(key, pending)
    revision += 1
    listeners.forEach((listener) => listener())
  },
  delete(key: string): void {
    requests.delete(key)
    revision += 1
    listeners.forEach((listener) => listener())
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  snapshot(): number {
    return revision
  }
}
