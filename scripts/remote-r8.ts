/**
 * Maintained real-host acceptance (R8): three mandatory cases against one SSH host with a
 * synthetic model provider. Plan mode (default) starts no SSH, SDK, provider or model process.
 *
 *   node --import ./scripts/test-loader.mjs scripts/remote-r8.ts --host <ssh-alias> \
 *     [--runtime-root <path>] [--prepare-timeout-minutes <1-30>] [--execute]
 *
 * Runs under Node like the production app; Bun is refused (exit 2).
 *
 * See docs/runtime/remote-r8.md.
 */
import { fileURLToPath } from 'node:url'

import { parseR8Args, R8_USAGE, R8UsageError } from './remote-r8/args'
import {
  defaultParentDependencies,
  executeParent,
  type ParentDependencies
} from './remote-r8/parent'
import { buildPlan, renderPlan } from './remote-r8/plan'
import { currentCommit, gitRunner, modifiedTrackedFiles, type GitRunner } from './remote-r8/tree'
import { REMOTE_OMP_MANIFEST } from '../src/main/agent/engine/rpc/runtime-deployment'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

export interface MainDependencies extends ParentDependencies {
  readonly ompVersion: string
}

export const NODE_COMMAND =
  'node --import ./scripts/test-loader.mjs scripts/remote-r8.ts --host <ssh-alias> [--execute]'

/** True when this process is Bun, whose fetch/stream behavior differs from the Electron app's Node. */
export function isBunRuntime(): boolean {
  return typeof process.versions.bun === 'string'
}

export function defaultMainDependencies(repoRoot = REPO_ROOT, git?: GitRunner): MainDependencies {
  const runner = git ?? gitRunner(repoRoot)
  return { ...defaultParentDependencies(repoRoot, runner), ompVersion: REMOTE_OMP_MANIFEST.version }
}

/** Returns the process exit code: 0 pass or plan, 1 failed run or refusal, 2 usage error. */
export async function main(
  argv: readonly string[],
  deps: MainDependencies = defaultMainDependencies(),
  bun: boolean = isBunRuntime()
): Promise<number> {
  if (bun) {
    console.error(
      `remote-r8 must run under Node, like the production app; Bun is not supported.\nUse: ${NODE_COMMAND}`
    )
    return 2
  }
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      deps.print(R8_USAGE)
      return 0
    }
    const args = parseR8Args(argv)
    if (!args.execute) {
      deps.print(
        renderPlan(
          buildPlan(args, {
            commit: currentCommit(deps.git),
            trackedFilesModified: modifiedTrackedFiles(deps.git).length,
            bundleHash: await deps.bundleHash(),
            ompVersion: deps.ompVersion
          })
        )
      )
      return 0
    }
    return (await executeParent(args, deps)).exitCode
  } catch (error) {
    if (error instanceof R8UsageError) {
      console.error(`${error.message}\n\n${R8_USAGE}`)
      return 2
    }
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), defaultMainDependencies())
}
