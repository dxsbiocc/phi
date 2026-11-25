import { posix } from 'node:path'

import { MAX_REMOTE_LOG_RAW_BYTES, readRemoteFileChunk } from '../wrappers/remote-ssh-log'
import { shellQuote, type RemoteSshSession } from '../wrappers/remote-ssh-session'
import {
  evaluateTextAssertion,
  type OutputAssertionResult,
  type OutputContentAssertion
} from './output-assertions'

const MAX_REMOTE_INSPECT_BYTES = 1024 * 1024 // 1 MiB bounded read

function withinPosixRoot(candidate: string, root: string): boolean {
  const cleanRoot = posix.resolve(root)
  const cleanCandidate = posix.resolve(candidate)
  return (
    cleanCandidate === cleanRoot ||
    cleanCandidate.startsWith(cleanRoot === '/' ? '/' : `${cleanRoot}/`)
  )
}

interface RemoteStatProbe {
  ok: true
  realRoot: string
  realTarget: string
  isRegularFile: boolean
  size: number
}

const PROBE_CODE_REASONS: Readonly<Record<number, string>> = {
  20: 'remote project root does not exist',
  21: 'file does not exist',
  22: 'file is unreadable',
  23: 'target is not a regular file'
}

function parseProbeStdout(stdout: string): RemoteStatProbe | { ok: false; reason: string } {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n')
  const realRoot = lines[0]?.trim() ?? ''
  const realTarget = lines[1]?.trim() ?? ''
  const size = Number(lines[2]?.trim() ?? 'NaN')
  if (!realRoot || !realTarget || !Number.isFinite(size) || size < 0) {
    return { ok: false, reason: 'unexpected remote stat output' }
  }
  return { ok: true, realRoot, realTarget, isRegularFile: true, size }
}

async function probeRemoteRegularFile(
  session: RemoteSshSession,
  remoteTarget: string,
  remoteRoot: string
): Promise<RemoteStatProbe | { ok: false; reason: string; unreachable?: boolean }> {
  const cmd = [
    `root_real=$(realpath ${shellQuote(remoteRoot)} 2>/dev/null) || exit 20`,
    `if [ ! -e ${shellQuote(remoteTarget)} ] && [ ! -L ${shellQuote(remoteTarget)} ]; then exit 21; fi`,
    `target_real=$(realpath ${shellQuote(remoteTarget)} 2>/dev/null) || exit 22`,
    `if [ ! -f "$target_real" ]; then exit 23; fi`,
    `sz=$(wc -c < "$target_real" | tr -d '[:space:]')`,
    `printf '%s\\n%s\\n%s\\n' "$root_real" "$target_real" "$sz"`
  ].join('\n')

  let res
  try {
    res = await session.exec(cmd)
  } catch (error) {
    return {
      ok: false,
      unreachable: true,
      reason: `remote SSH host unreachable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const knownReason = res.code !== null ? PROBE_CODE_REASONS[res.code] : undefined
  if (knownReason) return { ok: false, reason: knownReason }
  if (res.code !== 0) {
    return {
      ok: false,
      unreachable: res.code === null || res.code === 255,
      reason: res.stderr.trim() || `remote stat exited with code ${String(res.code)}`
    }
  }
  return parseProbeStdout(res.stdout)
}

function assertionRequiresBodyRead(assertion: OutputContentAssertion): boolean {
  return (
    assertion.format !== undefined ||
    assertion.minDataRows !== undefined ||
    assertion.minColumns !== undefined ||
    (assertion.requiredColumns?.length ?? 0) > 0
  )
}

async function readRemoteBoundedPrefix(
  session: RemoteSshSession,
  realTarget: string,
  initialSize: number,
  maxBytes: number
): Promise<
  | { ok: true; totalSize: number; text: string; truncated: boolean }
  | { ok: false; reason: string; unreachable?: boolean }
> {
  try {
    const chunks: Buffer[] = []
    let offset = 0
    let totalSize = initialSize
    const targetBytes = maxBytes + 1
    while (offset < targetBytes && offset < totalSize) {
      const pageLimit = Math.min(MAX_REMOTE_LOG_RAW_BYTES, targetBytes - offset)
      const chunk = await readRemoteFileChunk(session, realTarget, {
        offset,
        maxBytes: pageLimit
      })
      if (chunk.missing) return { ok: false, reason: 'file does not exist' }
      totalSize = chunk.size
      if (chunk.bytes.byteLength === 0) break
      chunks.push(chunk.bytes)
      offset = chunk.nextOffset
    }
    const combined = Buffer.concat(chunks)
    const truncated = combined.byteLength > maxBytes || totalSize > maxBytes
    const slice = combined.subarray(0, Math.min(combined.byteLength, maxBytes))
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(slice)
      return { ok: true, totalSize, text, truncated }
    } catch {
      return { ok: false, reason: 'file is not valid UTF-8' }
    }
  } catch (error) {
    return {
      ok: false,
      unreachable: true,
      reason: `remote file read failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * Evaluates a read-only content assertion against an artifact on an SSH remote workspace.
 * Never falls back to local disk and fails closed if the SSH connection fails.
 */
export async function verifyRemoteFileContentAssertion(
  session: RemoteSshSession,
  remoteFilePath: string,
  assertion: OutputContentAssertion,
  options: { remoteRootDir?: string; maxBytes?: number } = {}
): Promise<OutputAssertionResult & { unreachable?: boolean }> {
  const maxBytes = options.maxBytes ?? MAX_REMOTE_INSPECT_BYTES
  if (options.remoteRootDir && !withinPosixRoot(remoteFilePath, options.remoteRootDir)) {
    return { ok: false, reason: 'path escapes allowed root directory' }
  }

  const rootToProbe = options.remoteRootDir ?? posix.dirname(posix.resolve(remoteFilePath))
  const stat = await probeRemoteRegularFile(session, remoteFilePath, rootToProbe)
  if (!stat.ok) return stat
  if (options.remoteRootDir && !withinPosixRoot(stat.realTarget, stat.realRoot)) {
    return { ok: false, reason: 'path symlink escapes allowed root directory' }
  }
  if (!assertionRequiresBodyRead(assertion)) {
    return evaluateTextAssertion(stat.size, { text: '', truncated: false }, assertion, maxBytes)
  }

  const fetched = await readRemoteBoundedPrefix(session, stat.realTarget, stat.size, maxBytes)
  if (!fetched.ok) return fetched
  return evaluateTextAssertion(
    fetched.totalSize,
    { text: fetched.text, truncated: fetched.truncated },
    assertion,
    maxBytes
  )
}
