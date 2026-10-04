import { utilityProcess } from 'electron'

import {
  BUNDLED_WRAPPER_SOURCE_FINGERPRINT,
  getBundledWrapperPackagesDir,
  type BundledWrapperInstallOptions,
  type BundledWrapperInstallResult
} from './catalog'
import workerPath from './bundled-install-worker?modulePath'

export interface BundledWrapperInstallRequest {
  agentDir: string
  options: BundledWrapperInstallOptions
}

export type BundledWrapperInstallResponse =
  { ok: true; result: BundledWrapperInstallResult } | { ok: false; error: string }

/**
 * Runs `ensureBundledWrappersInstalled` in an Electron utility process so first-run
 * setup (archive builds, staging, tree copies) never blocks the main event loop, and
 * the app can still quit while it runs. The source root is resolved here because the
 * utility process has no `app` to locate the packaged resources; the shipped digest
 * is passed with it so the worker does not re-hash the source tree.
 */
export function installBundledWrappersInUtilityProcess(
  agentDir: string,
  options: Pick<BundledWrapperInstallOptions, 'packageVersion'>
): Promise<BundledWrapperInstallResult> {
  const request: BundledWrapperInstallRequest = {
    agentDir,
    options: {
      ...options,
      sourceRoot: getBundledWrapperPackagesDir(),
      sourceFingerprint: BUNDLED_WRAPPER_SOURCE_FINGERPRINT
    }
  }
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: 'Phi Wrapper Install',
      stdio: 'ignore'
    })
    let settled = false
    child.once('message', (response: BundledWrapperInstallResponse) => {
      settled = true
      child.kill()
      if (response.ok) resolve(response.result)
      else reject(new Error(response.error))
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      reject(new Error(`bundled wrapper install process exited with code ${code}`))
    })
    child.postMessage(request)
  })
}
