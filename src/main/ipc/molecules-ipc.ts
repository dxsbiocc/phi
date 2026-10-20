import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { renderMoleculeSvg } from '../molecule-renderer'

export interface MoleculesIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
}

export function registerMoleculesIpc(options: MoleculesIpcOptions): void {
  const { ipcMain } = options
  ipcMain.handle(
    IPC.molecules.renderSvg,
    async (_, value: unknown, width: unknown, height: unknown) => {
      return renderMoleculeSvg(value, width, height)
    }
  )
}
