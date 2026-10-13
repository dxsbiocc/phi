import type { MenuBarAction } from '../shared/menuBarTypes'

export type MenuBarMenuItem =
  | { label: string; enabled?: boolean; click: () => void }
  | {
      type: 'separator'
    }

export interface MenuBarTray {
  setToolTip: (tooltip: string) => void
  onClick: (listener: () => void) => void
  onRightClick: (listener: () => void) => void
  popUpContextMenu: (menu: unknown) => void
  destroy: () => void
}

interface CreateMenuBarControllerOptions {
  platform: NodeJS.Platform
  createTray: () => MenuBarTray
  buildMenu: (items: readonly MenuBarMenuItem[]) => unknown
  openWindow: () => void
  queueAction: (action: MenuBarAction) => void
  hideWindow: () => void
  canHideWindow: () => boolean
  quit: () => void
}

export interface MenuBarController {
  destroy: () => void
}

export function createMenuBarController(
  options: CreateMenuBarControllerOptions
): MenuBarController | null {
  if (options.platform !== 'darwin') return null

  const tray = options.createTray()
  tray.setToolTip('Phi')
  tray.onClick(options.openWindow)
  tray.onRightClick(() => {
    tray.popUpContextMenu(
      options.buildMenu([
        { label: '打开 Phi', click: options.openWindow },
        { label: '新建对话', click: () => options.queueAction('new-chat') },
        { label: '设置…', click: () => options.queueAction('open-settings') },
        { type: 'separator' },
        {
          label: '隐藏窗口',
          enabled: options.canHideWindow(),
          click: options.hideWindow
        },
        { type: 'separator' },
        { label: '退出 Phi', click: options.quit }
      ])
    )
  })

  return {
    destroy: () => tray.destroy()
  }
}
