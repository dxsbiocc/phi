import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'

import menuBarIconPath from '../../build/phiTemplate.png?asset'
import menuBarIcon2xPath from '../../build/phiTemplate@2x.png?asset'
import {
  createMenuBarController,
  type MenuBarController,
  type MenuBarMenuItem
} from './menu-bar-controller'
import type { MenuBarAction } from '../shared/menuBarTypes'
import type { UiLanguage } from '../shared/uiLanguage'

interface CreateMacMenuBarOptions {
  openWindow: () => void
  queueAction: (action: MenuBarAction) => void
  hideWindow: () => void
  canHideWindow: () => boolean
  quit: () => void
  getUiLanguage?: () => UiLanguage
}

export function createMacMenuBar(options: CreateMacMenuBarOptions): MenuBarController | null {
  if (process.platform !== 'darwin') return null

  const icon = nativeImage.createFromPath(menuBarIconPath)
  const retinaIcon = nativeImage.createFromPath(menuBarIcon2xPath)
  if (icon.isEmpty()) return null
  if (!retinaIcon.isEmpty()) {
    icon.addRepresentation({ scaleFactor: 2, dataURL: retinaIcon.toDataURL() })
  }
  icon.setTemplateImage(true)

  return createMenuBarController({
    platform: process.platform,
    createTray: () => {
      const tray = new Tray(icon)
      return {
        setToolTip: (tooltip) => tray.setToolTip(tooltip),
        onClick: (listener) => {
          tray.on('click', listener)
        },
        onRightClick: (listener) => {
          tray.on('right-click', listener)
        },
        popUpContextMenu: (menu) => tray.popUpContextMenu(menu as Menu),
        destroy: () => tray.destroy()
      }
    },
    buildMenu: (items: readonly MenuBarMenuItem[]) =>
      Menu.buildFromTemplate(items as MenuItemConstructorOptions[]),
    ...options
  })
}
