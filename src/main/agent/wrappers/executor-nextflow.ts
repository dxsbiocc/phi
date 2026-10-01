import { join } from 'node:path'

import type { WrapperManifest } from './manifest-types'
import type { WrapperRunPlan } from './types'

export interface NextflowInvocation {
  args: string[]
  /** Written to `params.json` in the run directory before launch. */
  paramsJson: string
}

/**
 * Builds the arguments for one plan — pure and engine-specific. Launcher
 * resolution is deliberately separate so local execution always uses an
 * absolute managed/explicit-host command while remote executors keep their
 * own command construction. Never generates workflow code, only the fixed
 * entrypoint's arguments (see technical design's Execution Model).
 */
export function buildNextflowInvocation(
  manifest: WrapperManifest,
  plan: WrapperRunPlan,
  installedPath: string,
  absoluteOutDir: string,
  weblogUrl?: string
): NextflowInvocation {
  const entrypointPath = join(installedPath, manifest.engine.entrypoint)
  const args = [
    'run',
    entrypointPath,
    '-params-file',
    'params.json',
    '-profile',
    plan.nextflowProfile ?? plan.profile
  ]
  if (weblogUrl) {
    args.push('-with-weblog', weblogUrl)
  }

  const params: Record<string, unknown> = { ...plan.params }
  if (params.outdir === undefined) {
    params.outdir = absoluteOutDir
  }

  return {
    args,
    paramsJson: JSON.stringify(params, null, 2)
  }
}
