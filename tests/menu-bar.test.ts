import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  createMenuBarController,
  type MenuBarMenuItem,
  type MenuBarTray
} from '../src/main/menu-bar-controller'
import type { MenuBarAction } from '../src/shared/menuBarTypes'

class FakeTray implements MenuBarTray {
  tooltip = ''
  destroyed = false
  poppedMenu: unknown = null
  listeners = new Map<string, () => void>()

  setToolTip(tooltip: string): void {
    this.tooltip = tooltip
  }

  onClick(listener: () => void): void {
    this.listeners.set('click', listener)
  }

  onRightClick(listener: () => void): void {
    this.listeners.set('right-click', listener)
  }

  popUpContextMenu(menu: unknown): void {
    this.poppedMenu = menu
  }

  destroy(): void {
    this.destroyed = true
  }
}

test('macOS menu bar provides focused app actions without hijacking primary click', () => {
  const tray = new FakeTray()
  const events: string[] = []
  const actions: MenuBarAction[] = []
  let builtItems: readonly MenuBarMenuItem[] = []
  const controller = createMenuBarController({
    platform: 'darwin',
    createTray: () => tray,
    buildMenu: (items) => {
      builtItems = items
      return items
    },
    openWindow: () => events.push('open'),
    queueAction: (action) => actions.push(action),
    hideWindow: () => events.push('hide'),
    canHideWindow: () => true,
    quit: () => events.push('quit')
  })

  assert.ok(controller)
  assert.equal(tray.tooltip, 'Phi')
  tray.listeners.get('click')?.()
  assert.deepEqual(events, ['open'])

  tray.listeners.get('right-click')?.()
  assert.equal(tray.poppedMenu, builtItems)
  const clickable = builtItems.filter(
    (item): item is Extract<MenuBarMenuItem, { label: string }> => 'label' in item
  )
  assert.deepEqual(
    clickable.map((item) => item.label),
    ['打开 Phi', '新建对话', '设置…', '隐藏窗口', '退出 Phi']
  )
  clickable.find((item) => item.label === '新建对话')?.click()
  clickable.find((item) => item.label === '设置…')?.click()
  clickable.find((item) => item.label === '隐藏窗口')?.click()
  clickable.find((item) => item.label === '退出 Phi')?.click()
  assert.deepEqual(actions, ['new-chat', 'open-settings'])
  assert.deepEqual(events, ['open', 'hide', 'quit'])

  controller.destroy()
  assert.equal(tray.destroyed, true)
})

test('menu bar is macOS-only and uses template image plus an explicit renderer command bridge', () => {
  let created = false
  assert.equal(
    createMenuBarController({
      platform: 'linux',
      createTray: () => {
        created = true
        return new FakeTray()
      },
      buildMenu: (items) => items,
      openWindow: () => undefined,
      queueAction: () => undefined,
      hideWindow: () => undefined,
      canHideWindow: () => false,
      quit: () => undefined
    }),
    null
  )
  assert.equal(created, false)

  const adapter = readFileSync('src/main/menu-bar.ts', 'utf8')
  const main = readFileSync('src/main/index.ts', 'utf8')
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  const ambient = readFileSync('src/preload/index.d.ts', 'utf8')
  const renderer = readFileSync('src/renderer/src/App.tsx', 'utf8')
  assert.match(adapter, /setTemplateImage\(true\)/)
  assert.match(adapter, /addRepresentation\(\{ scaleFactor: 2/)
  assert.match(main, /ipcMain\.handle\('menu-bar:consume-action'/)
  assert.match(preload, /ipcRenderer\.invoke\('menu-bar:consume-action'\)/)
  assert.match(ambient, /consumeMenuBarAction: \(\) => Promise<MenuBarAction \| null>/)
  assert.match(renderer, /rendererApi\.consumeMenuBarAction\(\)/)
})
