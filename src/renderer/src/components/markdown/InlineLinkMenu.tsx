import { useState, type ReactNode } from 'react'
import { ListItemIcon, ListItemText, Menu, MenuItem, Portal, Snackbar } from '@mui/material'

export type InlineLinkMenuAction = {
  id: string
  label: string
  icon: ReactNode
  disabled?: boolean
  onSelect: () => void | Promise<void>
}

export function InlineLinkMenu({
  id,
  kind,
  position,
  actions,
  onClose
}: {
  id: string
  kind: 'file' | 'web' | 'resource'
  position: { top: number; left: number } | null
  actions: InlineLinkMenuAction[]
  onClose: () => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const run = (action: InlineLinkMenuAction): void => {
    if (position === null) return
    onClose()
    const report = (): void => setError(`${action.label}失败，请重试。`)
    try {
      void Promise.resolve(action.onSelect()).catch(report)
    } catch {
      report()
    }
  }

  return (
    <>
      <Menu
        id={id}
        data-phi-inline-link-menu={kind}
        open={position !== null}
        onClose={onClose}
        anchorReference="anchorPosition"
        anchorPosition={position ?? undefined}
        slotProps={{
          list: {
            dense: true,
            'aria-label':
              kind === 'file' ? '文件链接操作' : kind === 'web' ? '网页链接操作' : '资源操作'
          },
          paper: {
            elevation: 0,
            sx: {
              minWidth: 176,
              borderRadius: 1.5,
              boxShadow: (theme) => theme.customShadows?.dropdown ?? theme.shadows[4]
            }
          }
        }}
      >
        {actions.map((action) => (
          <MenuItem key={action.id} disabled={action.disabled} onClick={() => run(action)}>
            <ListItemIcon sx={{ minWidth: 28 }}>{action.icon}</ListItemIcon>
            <ListItemText
              primary={action.label}
              slotProps={{ primary: { sx: { fontSize: 14 } } }}
            />
          </MenuItem>
        ))}
      </Menu>
      {error !== null ? (
        <Portal>
          <Snackbar open message={error} autoHideDuration={4000} onClose={() => setError(null)} />
        </Portal>
      ) : null}
    </>
  )
}
