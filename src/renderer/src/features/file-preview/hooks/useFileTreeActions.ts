import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import type { FileTreeEntry } from '../../../types'
import {
  fileTreeEntryActions,
  fileTreeDisplayPath,
  fileTreeRenameError,
  type FileTreeAction,
  type FileTreeActions
} from '../lib/fileTreeActions'
import type { FileTreeActionMenuProps } from '../components/FileTreeActionMenu'

export type FileTreeMenuTarget = {
  entry: FileTreeEntry
  position: { top: number; left: number }
  scope: object
}

export type FileTreeActionDialog = {
  entry: FileTreeEntry
  mode: 'rename' | 'delete'
  scope: object
}

type FileTreeActionController = {
  onContextMenu: (entry: FileTreeEntry, event: MouseEvent<HTMLElement>) => void
  onKeyDown: (entry: FileTreeEntry, event: KeyboardEvent<HTMLElement>) => void
  onDownload: (entry: FileTreeEntry) => void
  menuProps: FileTreeActionMenuProps
}

export function useFileTreeActions({
  scope,
  rootPath,
  fileActions,
  onOpenEntry,
  onMutation
}: {
  scope: string
  rootPath: string
  fileActions?: FileTreeActions
  onOpenEntry: (entry: FileTreeEntry) => void
  onMutation: (entry: FileTreeEntry) => void
}): FileTreeActionController {
  const actionScope = useMemo(() => ({ scope, rootPath }), [scope, rootPath])
  const currentScope = useRef(actionScope)
  useLayoutEffect(() => {
    currentScope.current = actionScope
  }, [actionScope])
  const [menu, setMenu] = useState<FileTreeMenuTarget | null>(null)
  const [dialog, setDialog] = useState<FileTreeActionDialog | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const visibleMenu = menu?.scope === actionScope ? menu : null
  const visibleDialog = dialog?.scope === actionScope ? dialog : null

  const openMenu = (entry: FileTreeEntry, position: FileTreeMenuTarget['position']): void => {
    setNotice('')
    setMenu({ entry, position, scope: actionScope })
  }

  const runAction = async (action: FileTreeAction, entry: FileTreeEntry): Promise<void> => {
    setMenu(null)
    if (!fileTreeEntryActions(entry, rootPath, fileActions).includes(action)) return
    if (action === 'rename' || action === 'delete') {
      setError('')
      setBusy(false)
      setNewName(entry.name)
      setDialog({ entry, mode: action, scope: actionScope })
      return
    }
    try {
      if (action === 'open') onOpenEntry(entry)
      if (action === 'download') fileActions?.onDownloadFile?.(entry.path)
      if (action === 'reveal') fileActions?.onRevealFile?.(entry.path)
      if (action === 'copy') await navigator.clipboard.writeText(fileTreeDisplayPath(entry))
    } catch (cause) {
      if (currentScope.current === actionScope) {
        setNotice(cause instanceof Error ? cause.message : '操作失败，请重试')
      }
    }
  }

  const submit = async (): Promise<void> => {
    if (!visibleDialog || busy) return
    const target = visibleDialog
    if (!fileTreeEntryActions(target.entry, rootPath, fileActions).includes(target.mode)) return
    const validation = target.mode === 'rename' ? fileTreeRenameError(newName) : ''
    if (validation) {
      setError(validation)
      return
    }
    if (target.mode === 'rename' && newName === target.entry.name) {
      setDialog(null)
      return
    }
    setBusy(true)
    setError('')
    try {
      if (target.mode === 'rename') await fileActions?.onRenameFile?.(target.entry.path, newName)
      else await fileActions?.onDeleteFile?.(target.entry.path)
      if (currentScope.current !== actionScope) return
      setDialog(null)
      onMutation(target.entry)
    } catch (cause) {
      if (currentScope.current === actionScope) {
        setError(cause instanceof Error ? cause.message : '操作失败，请重试')
      }
    } finally {
      if (currentScope.current === actionScope) setBusy(false)
    }
  }

  return {
    onContextMenu: (entry: FileTreeEntry, event: MouseEvent<HTMLElement>): void => {
      event.preventDefault()
      event.stopPropagation()
      openMenu(entry, { left: event.clientX, top: event.clientY })
    },
    onKeyDown: (entry: FileTreeEntry, event: KeyboardEvent<HTMLElement>): void => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      event.preventDefault()
      event.stopPropagation()
      const rect = event.currentTarget.getBoundingClientRect()
      openMenu(entry, { left: rect.left + 24, top: rect.bottom })
    },
    onDownload: (entry: FileTreeEntry): void => {
      void runAction('download', entry)
    },
    menuProps: {
      menu: visibleMenu,
      actions: visibleMenu ? fileTreeEntryActions(visibleMenu.entry, rootPath, fileActions) : [],
      onCloseMenu: (): void => setMenu(null),
      onAction: (action: FileTreeAction): void => {
        if (visibleMenu) void runAction(action, visibleMenu.entry)
      },
      dialog: visibleDialog,
      newName,
      onNameChange: (name: string): void => {
        setNewName(name)
        setError('')
      },
      busy,
      error,
      onCloseDialog: (): void => {
        if (!busy) setDialog(null)
      },
      onSubmit: (): void => {
        void submit()
      },
      notice,
      onCloseNotice: (): void => setNotice('')
    }
  }
}
