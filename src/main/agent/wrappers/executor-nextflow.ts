import { join } from 'node:path'

import type { WrapperManifest } from './manifest-types'
import type { WrapperRunPlan } from './types'

export interface NextflowLaunchPlan {
  command: string
  args: string[]
  /** Written to `params.json` in the run directory before launch. */
  paramsJson: string
}

/**
 * Builds the Nextflow invocation for one plan — pure and engine-specific,
 * so it's reusable by a Phase 2 remote executor without duplicating this
 * logic. Never generates workflow code, only the fixed entrypoint's launch
 * arguments (see technical design's Execution Model: "Workflow code is
 * fixed").
 */
export function buildNextflowLaunch(
  manifest: WrapperManifest,
  plan: WrapperRunPlan,
  installedPath: string,
  absoluteOutDir: string,
  weblogUrl?: string
): NextflowLaunchPlan {
  const entrypointPath = join(installedPath, manifest.engine.entrypoint)
  const args = ['run', entrypointPath, '-params-file', 'params.json', '-profile', plan.profile]
  if (weblogUrl) {
    args.push('-with-weblog', weblogUrl)
  }

  const params: Record<string, unknown> = { ...plan.params }
  if (params.outdir === undefined) {
    params.outdir = absoluteOutDir
  }

  return {
    command: 'nextflow',
    args,
    paramsJson: JSON.stringify(params, null, 2)
  }
}
