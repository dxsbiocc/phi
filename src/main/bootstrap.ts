import { app, dialog } from 'electron'
import { writeAppLog } from './agent/app-logger'
import { readAppUiLanguage } from './agent/app-settings'
import { redactSensitiveText } from './agent/redaction'
import { nativeUiCopy } from './native-ui-copy'
import { DEFAULT_UI_LANGUAGE, systemUiLanguage, type UiLanguage } from '../shared/uiLanguage'

function startupLanguage(): UiLanguage {
  let fallback = DEFAULT_UI_LANGUAGE
  try {
    fallback = systemUiLanguage(app.getPreferredSystemLanguages())
  } catch {
    // System preferences may be unavailable during startup failure.
  }
  return readAppUiLanguage(fallback)
}

function startupDiagnostic(error: unknown): string {
  try {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    return redactSensitiveText(detail).slice(0, 500)
  } catch {
    return 'Could not read the startup error'
  }
}

async function reportStartupFailure(
  event: 'bootstrap_load_failed' | 'bootstrap_initialization_failed',
  error: unknown,
  stop: () => void
): Promise<void> {
  const diagnostic = startupDiagnostic(error)
  writeAppLog({ level: 'error', event, metadata: { error: diagnostic } })
  console.error(`[Phi] ${event}: ${diagnostic}`)
  try {
    await app.whenReady()
    const copy = nativeUiCopy(startupLanguage())
    await dialog.showMessageBox({
      title: 'Phi',
      type: 'error',
      message: copy.launchFailed,
      detail: copy.launchRecovery,
      buttons: [copy.close],
      noLink: true
    })
  } catch {
    console.error('[Phi] Could not show the startup dialog')
  } finally {
    stop()
  }
}

try {
  // The packaged entry must finish evaluating before Electron emits ready.
  // Wait for pre-ready registration in the main module, then observe startup separately.
  const { startup, stopAfterStartupFailure } = await import('./index')
  void startup.catch((error: unknown) =>
    reportStartupFailure('bootstrap_initialization_failed', error, stopAfterStartupFailure)
  )
} catch (error) {
  void reportStartupFailure('bootstrap_load_failed', error, () => app.exit(1))
}
