import { join } from 'node:path'

import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import { officeKindAdapter } from './office-kind-adapters'

export interface OfficeSaveAsDialogWindow {
  isDestroyed(): boolean
}

export interface OfficeSaveAsDialogOptions {
  readonly title: string
  readonly defaultPath: string
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[]
}

interface OfficeSaveAsDialogDependencies {
  readonly testHooksEnabled: boolean
  readonly isPackaged: boolean
  readonly smokePath?: string
  readonly getWindow: () => OfficeSaveAsDialogWindow | undefined
  readonly showSaveDialog: (
    window: OfficeSaveAsDialogWindow | undefined,
    options: OfficeSaveAsDialogOptions
  ) => Promise<{ readonly canceled: boolean; readonly filePath?: string }>
}

export async function chooseOfficeSaveAsTarget(
  input: {
    readonly projectRoot: string
    readonly fileName: string
    readonly kind?: OfficeDocumentKind
  },
  dependencies: OfficeSaveAsDialogDependencies
): Promise<string | null> {
  if (dependencies.testHooksEnabled && !dependencies.isPackaged && dependencies.smokePath) {
    return dependencies.smokePath
  }
  const window = liveWindow(dependencies.getWindow)
  const adapter = officeKindAdapter(input.kind ?? 'xlsx')
  const result = await dependencies.showSaveDialog(window, {
    title: `另存为 ${adapter.extension.slice(1).toUpperCase()}`,
    defaultPath: join(input.projectRoot, input.fileName),
    filters: [{ name: adapter.displayName, extensions: [adapter.extension.slice(1)] }]
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
