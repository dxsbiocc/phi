import { join } from 'node:path'

import type { OfficeExportFormat } from './office-export-contract'
import type { OfficeSaveAsDialogOptions, OfficeSaveAsDialogWindow } from './office-save-as-dialog'

interface OfficeExportDialogDependencies {
  readonly officeDev: boolean
  readonly isPackaged: boolean
  readonly smokePath?: string
  readonly getWindow: () => OfficeSaveAsDialogWindow | undefined
  readonly showSaveDialog: (
    window: OfficeSaveAsDialogWindow | undefined,
    options: OfficeSaveAsDialogOptions
  ) => Promise<{ readonly canceled: boolean; readonly filePath?: string }>
}

export async function chooseOfficeExportTarget(
  input: {
    readonly projectRoot: string
    readonly fileName: string
    readonly format: OfficeExportFormat
  },
  dependencies: OfficeExportDialogDependencies
): Promise<string | null> {
  if (dependencies.officeDev && !dependencies.isPackaged && dependencies.smokePath) {
    return dependencies.smokePath
  }
  const window = liveWindow(dependencies.getWindow)
  const label = input.format.toUpperCase()
  const result = await dependencies.showSaveDialog(window, {
    title: `导出为 ${label}`,
    defaultPath: join(input.projectRoot, input.fileName),
    filters: [{ name: label, extensions: [input.format] }]
  })
  return result.canceled || !result.filePath ? null : result.filePath
}

function liveWindow(
  getWindow: () => OfficeSaveAsDialogWindow | undefined
): OfficeSaveAsDialogWindow | undefined {
  try {
    const window = getWindow()
    return window && !window.isDestroyed() ? window : undefined
  } catch {
    return undefined
  }
}
