import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import type {
  RemoteRuntimeRootCheckResult,
  RemoteRuntimeRootHardError
} from '../../../shared/remoteRuntimeRootTypes'
import {
  parseRemoteRuntimeRootCheck,
  remoteRuntimeRootCheckFailure,
  type RemoteRuntimeRootParseOptions
} from './runtime-root-check-parser'
import { buildRemoteRuntimeRootCheckScript } from './runtime-root-check-script'
import type { RemoteRuntimeRootCheckScriptOptions } from './runtime-root-check-script'

export {
  DEFAULT_REMOTE_RUNTIME_ROOT_HIGH_DISK_USE_PERCENT,
  DEFAULT_REMOTE_RUNTIME_ROOT_LOW_SPACE_KIB,
  parseRemoteRuntimeRootCheck
} from './runtime-root-check-parser'
export { buildRemoteRuntimeRootCheckScript } from './runtime-root-check-script'

export interface RemoteRuntimeRootCheckOptions
  extends RemoteRuntimeRootParseOptions, RemoteRuntimeRootCheckScriptOptions {
  timeoutMs?: number
}

export type RemoteRuntimeRootCheckSession = Pick<RemoteSshSession, 'execWithInput'>

export const DEFAULT_REMOTE_RUNTIME_ROOT_CHECK_TIMEOUT_MS = 30_000

function configuredRootError(configuredRoot: string): RemoteRuntimeRootHardError | undefined {
  if (!configuredRoot || configuredRoot.includes('\0') || /[\r\n]/.test(configuredRoot)) {
    return {
      code: 'invalid-configured-root',
      message: 'Runtime root must not be empty or contain NUL or newline characters.'
    }
  }
  if (!(configuredRoot.startsWith('/') || configuredRoot.startsWith('~/'))) {
    return {
      code: 'invalid-configured-root',
      message: 'Runtime root must be an absolute path or start with ~/.'
    }
  }
  if (configuredRoot.split('/').includes('..')) {
    return {
      code: 'invalid-configured-root',
      message: 'Runtime root must not contain .. path segments.'
    }
  }
  return undefined
}

function invalidResult(
  configured: string,
  error: RemoteRuntimeRootHardError,
  now: () => Date
): RemoteRuntimeRootCheckResult {
  return {
    ...remoteRuntimeRootCheckFailure(configured, 'failed', now),
    status: 'checked',
    hardErrors: [error]
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('REMOTE_RUNTIME_ROOT_CHECK_TIMEOUT')),
      timeoutMs
    )
    timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export async function checkRemoteRuntimeRoot(
  session: RemoteRuntimeRootCheckSession,
  configuredRoot: string,
  options: RemoteRuntimeRootCheckOptions = {}
): Promise<RemoteRuntimeRootCheckResult> {
  const now = options.now ?? (() => new Date())
  const invalid = configuredRootError(configuredRoot)
  if (invalid) return invalidResult(configuredRoot, invalid, now)
  if (!session.execWithInput) return remoteRuntimeRootCheckFailure(configuredRoot, 'failed', now)
  try {
    const result = await withTimeout(
      session.execWithInput('sh -s', buildRemoteRuntimeRootCheckScript(configuredRoot, options)),
      options.timeoutMs ?? DEFAULT_REMOTE_RUNTIME_ROOT_CHECK_TIMEOUT_MS
    )
    if (result.code !== 0) return remoteRuntimeRootCheckFailure(configuredRoot, 'failed', now)
    return parseRemoteRuntimeRootCheck(result.stdout, configuredRoot, options)
  } catch (error) {
    const timedOut = error instanceof Error && error.message === 'REMOTE_RUNTIME_ROOT_CHECK_TIMEOUT'
    return remoteRuntimeRootCheckFailure(configuredRoot, timedOut ? 'timed-out' : 'failed', now)
  }
}
