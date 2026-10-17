import { DEFAULT_PREPARE_MINUTES, MAX_PREPARE_MINUTES } from './types'
import {
  DEFAULT_REMOTE_RUNTIME_ROOT,
  normalizeRemoteRuntimeRoot
} from '../../src/main/agent/remote-runtime-root'
import { validateHostAlias } from '../../src/main/agent/wrappers/remote-ssh-session'

export interface R8Args {
  readonly host: string
  /** Normalized runtime root; the default is `~/.phi/runtime`. */
  readonly runtimeRoot: string
  readonly runtimeRootExplicit: boolean
  readonly execute: boolean
  /** Bound of the prepare phase in minutes. */
  readonly prepareTimeoutMinutes: number
}

export class R8UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'R8UsageError'
  }
}

export const R8_USAGE = [
  'Usage: node --import ./scripts/test-loader.mjs scripts/remote-r8.ts --host <ssh-alias> \\',
  '         [--runtime-root <path>] [--prepare-timeout-minutes <1-30>] [--execute]',
  '',
  '  --host <alias>          any alias from ~/.ssh/config',
  '  --runtime-root <path>   server runtime root (absolute or ~/...); default ~/.phi/runtime',
  `  --prepare-timeout-minutes <n>  bound of the prepare phase, default ${DEFAULT_PREPARE_MINUTES}, max ${MAX_PREPARE_MINUTES}`,
  '  --execute               run for real; without it only the plan is printed'
].join('\n')

/** Strict parser: every flag is known, single-valued and takes its value as the next argument. */
export function parseR8Args(argv: readonly string[]): R8Args {
  let host: string | undefined
  let runtimeRoot: string | undefined
  let execute = false
  let prepare: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--execute') {
      if (execute) throw new R8UsageError('--execute was given twice')
      execute = true
      continue
    }
    if (flag !== '--host' && flag !== '--runtime-root' && flag !== '--prepare-timeout-minutes')
      throw new R8UsageError(`Unknown argument: ${flag}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--'))
      throw new R8UsageError(`${flag} needs a value`)
    index++
    if (flag === '--host') {
      if (host !== undefined) throw new R8UsageError('--host was given twice')
      host = value
    } else if (flag === '--prepare-timeout-minutes') {
      if (prepare !== undefined) throw new R8UsageError('--prepare-timeout-minutes was given twice')
      prepare = value
    } else {
      if (runtimeRoot !== undefined) throw new R8UsageError('--runtime-root was given twice')
      runtimeRoot = value
    }
  }
  if (host === undefined) throw new R8UsageError('--host is required')
  let prepareTimeoutMinutes = DEFAULT_PREPARE_MINUTES
  if (prepare !== undefined) {
    prepareTimeoutMinutes = /^\d{1,2}$/.test(prepare) ? Number(prepare) : Number.NaN
    if (
      !Number.isInteger(prepareTimeoutMinutes) ||
      prepareTimeoutMinutes < 1 ||
      prepareTimeoutMinutes > MAX_PREPARE_MINUTES
    )
      throw new R8UsageError(
        `--prepare-timeout-minutes must be an integer from 1 to ${MAX_PREPARE_MINUTES}`
      )
  }
  try {
    validateHostAlias(host)
    return {
      host,
      runtimeRoot: normalizeRemoteRuntimeRoot(runtimeRoot ?? DEFAULT_REMOTE_RUNTIME_ROOT),
      runtimeRootExplicit: runtimeRoot !== undefined,
      execute,
      prepareTimeoutMinutes
    }
  } catch (error) {
    throw new R8UsageError(error instanceof Error ? error.message : 'Invalid arguments')
  }
}
