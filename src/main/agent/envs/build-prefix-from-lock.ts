import { createWriteStream, mkdirSync, unlinkSync, writeFileSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'

import type { EnsureEnvironmentInput } from './ensure'
import {
  isReplacedSourcePackageLinkFailure,
  linkScriptFailureFromOutput,
  unreplacedLinkScriptFailureFromOutput
} from './link-script-failures'
import { acquirePackageCacheLock } from './lock'
import { runMicromamba, withWsl, type RunMicromambaOptions } from './runtime'
import { toLinuxPath, wslRuntimeDirectory } from './wsl'

function logStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

async function closeLog(stream: WriteStream): Promise<void> {
  try {
    await finished(stream.end())
  } catch {
    // A build failure is more useful than a log-stream close error.
  }
}

export async function createFromLock(
  input: Pick<EnsureEnvironmentInput, 'lockText' | 'onProgress' | 'signal' | 'spec'>,
  prepared: { root: string; prefix: string; envId: string },
  wsl?: RunMicromambaOptions['wsl']
): Promise<void> {
  const temporaryRoot = wsl ? wslRuntimeDirectory(wsl) : prepared.root
  mkdirSync(join(temporaryRoot, 'state', 'tmp'), { recursive: true })
  const lockFile = join(temporaryRoot, 'state', 'tmp', `${prepared.envId}.lock.txt`)
  writeFileSync(lockFile, input.lockText, 'utf8')
  const logPath = join(prepared.root, 'logs', `${prepared.envId}-${logStamp()}.log`)
  const logStream = createWriteStream(logPath)
  input.onProgress?.({
    phase: 'create',
    message: wsl ? 'micromamba create (WSL2)' : 'micromamba create'
  })
  const prefix = wsl ? toLinuxPath(prepared.prefix, wsl.ready.distro) : prepared.prefix
  const lock = wsl ? toLinuxPath(lockFile, wsl.ready.distro) : lockFile
  try {
    if (input.signal?.aborted) throw new Error('environment build aborted')
    const cacheLock = await acquirePackageCacheLock({
      root: prepared.root,
      signal: input.signal,
      onWait: () => {
        input.onProgress?.({ phase: 'wait', message: 'waiting for the package cache' })
      }
    })
    let result: Awaited<ReturnType<typeof runMicromamba>>
    try {
      // micromamba 2.9.0: create --yes -p <prefix> -f <explicit lock>
      result = await runMicromamba(
        ['create', '--yes', '-p', prefix, '-f', lock],
        withWsl(
          {
            root: prepared.root,
            signal: input.signal,
            onOutput: (chunk) => {
              logStream.write(chunk.text)
              if (chunk.text.length > 0)
                input.onProgress?.({ phase: 'create', message: chunk.text })
            }
          },
          wsl
        )
      )
    } finally {
      cacheLock.release()
    }
    if (input.signal?.aborted || result.code === null) throw new Error('environment build aborted')
    const sourcePackages = input.spec.sourcePackages ?? []
    const scriptFailure =
      unreplacedLinkScriptFailureFromOutput(result.stderr, sourcePackages) ??
      unreplacedLinkScriptFailureFromOutput(result.stdout, sourcePackages)
    if (scriptFailure) {
      throw new Error(
        `micromamba ${scriptFailure.action} script failed for package '${scriptFailure.packageName}': ${scriptFailure.detail}`
      )
    }
    const deferred =
      linkScriptFailureFromOutput(result.stderr) ?? linkScriptFailureFromOutput(result.stdout)
    if (deferred && isReplacedSourcePackageLinkFailure(deferred, sourcePackages)) {
      input.onProgress?.({
        phase: 'create',
        message: `deferring failed ${deferred.packageName} post-link; pinned sourcePackages will replace it`
      })
    }
    if (result.code !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim()).split('\n')[0]
      throw new Error(
        detail
          ? `micromamba create failed (${result.code}): ${detail}`
          : `micromamba create failed (${result.code})`
      )
    }
  } finally {
    await closeLog(logStream)
    try {
      unlinkSync(lockFile)
    } catch {
      // Already gone; nothing to clean up.
    }
  }
}
