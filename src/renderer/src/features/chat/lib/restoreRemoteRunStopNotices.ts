import type { ChatItem } from '../../../types'

/** Recovery can persist a takeover notice before a foreground run exists to broadcast it. */
export function restoreRemoteRunStopNotices(cached: ChatItem[], persisted: ChatItem[]): ChatItem[] {
  const missing = persisted.filter(
    (item) =>
      item.role === 'warning' &&
      item.noticeKind === 'remote_run_stopped' &&
      !cached.some((existing) => existing.id === item.id)
  )
  if (missing.length === 0) return cached

  const next = [...cached]
  for (const notice of missing) {
    const noticeTime = notice.createdAt ? Date.parse(notice.createdAt) : NaN
    const followingIndex = Number.isFinite(noticeTime)
      ? next.findIndex((item) => {
          const itemTime = item.createdAt ? Date.parse(item.createdAt) : NaN
          return Number.isFinite(itemTime) && itemTime > noticeTime
        })
      : -1
    next.splice(followingIndex < 0 ? next.length : followingIndex, 0, notice)
  }
  return next
}
