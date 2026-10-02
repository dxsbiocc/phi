import { useCallback, useEffect, useState } from 'react'
import { Button, Snackbar } from '@mui/material'
import type { PackageUpdateView } from '../../../shared/packageManagerTypes'
import { PackageUpdatesDialog } from './PackageUpdatesDialog'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function PackageUpdateNotice(): React.JSX.Element {
  const [updates, setUpdates] = useState<PackageUpdateView[]>([])
  const [noticeOpen, setNoticeOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const acceptUpdates = useCallback((next: PackageUpdateView[]): void => {
    setUpdates(next)
    if (next.length > 0) setNoticeOpen(true)
  }, [])

  useEffect(() => {
    let active = true
    const unsubscribe = window.api.onPackageUpdatesAvailable((next) => {
      if (active) acceptUpdates(next)
    })
    void window.api
      .listPackageUpdates()
      .then((next) => {
        if (active) acceptUpdates(next)
      })
      .catch(() => undefined)
    return () => {
      active = false
      unsubscribe()
    }
  }, [acceptUpdates])

  const refresh = useCallback(async (): Promise<void> => {
    setUpdates(await window.api.listPackageUpdates())
  }, [])

  async function apply(update: PackageUpdateView): Promise<void> {
    setBusyKey(`${update.type}:${update.id}`)
    setError(null)
    try {
      await window.api.applyPackageUpdate(update.type, update.id)
      await refresh()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusyKey(null)
    }
  }

  async function applyAll(): Promise<void> {
    setBusyKey('all')
    setError(null)
    try {
      await window.api.applyAllPackageUpdates()
      await refresh()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <>
      <Snackbar
        open={noticeOpen && updates.length > 0}
        onClose={() => setNoticeOpen(false)}
        message={`有 ${updates.length} 个内容包可更新`}
        action={
          <Button
            color="primary"
            size="small"
            onClick={() => {
              setNoticeOpen(false)
              setDialogOpen(true)
            }}
          >
            查看
          </Button>
        }
      />
      <PackageUpdatesDialog
        open={dialogOpen}
        updates={updates}
        busyKey={busyKey}
        error={error}
        onClose={() => setDialogOpen(false)}
        onApply={(update) => void apply(update)}
        onApplyAll={() => void applyAll()}
      />
    </>
  )
}
