/**
 * Electron utility-process entry that runs the bundled wrapper install. The install is
 * synchronous file and archive work (seconds on a fresh profile), so it runs here instead
 * of on the main process event loop; see bundled-install-process.ts for the main side.
 */
import { ensureBundledWrappersInstalled } from './catalog'
import type {
  BundledWrapperInstallRequest,
  BundledWrapperInstallResponse
} from './bundled-install-process'

process.parentPort.once('message', (event) => {
  const { agentDir, options } = event.data as BundledWrapperInstallRequest
  const reply = (response: BundledWrapperInstallResponse): void => {
    process.parentPort.postMessage(response)
  }
  ensureBundledWrappersInstalled(agentDir, options).then(
    (result) => reply({ ok: true, result }),
    (error: unknown) =>
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
  )
})
