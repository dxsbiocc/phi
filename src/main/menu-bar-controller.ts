import type { MenuBarAction } from '../shared/menuBarTypes'
import { normalizeUiLanguage, type UiLanguage } from '../shared/uiLanguage'

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
  getUiLanguage?: () => UiLanguage
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
    const copy =
      normalizeUiLanguage(options.getUiLanguage?.()) === 'zh-CN'
        ? {
            open: '打开 Phi',
            chat: '新建对话',
            settings: '设置…',
            hide: '隐藏窗口',
            quit: '退出 Phi'
          }
        : {
            open: 'Open Phi',
            chat: 'New chat',
            settings: 'Settings…',
            hide: 'Hide window',
            quit: 'Quit Phi'
          }
    tray.popUpContextMenu(
      options.buildMenu([
        { label: copy.open, click: options.openWindow },
        { label: copy.chat, click: () => options.queueAction('new-chat') },
        { label: copy.settings, click: () => options.queueAction('open-settings') },
        { type: 'separator' },
        {
          label: copy.hide,
          enabled: options.canHideWindow(),
          click: options.hideWindow
        },
        { type: 'separator' },
        { label: copy.quit, click: options.quit }
      ])
    )
  })

  return {
    destroy: () => tray.destroy()
  }
}
