import { posix } from 'node:path'

import type { PhiSessionManifest } from '../../session/session-store'
import { remoteOmpJournalPath, type RemoteOmpRuntimeRef } from '../../session/runtime-reference'
import { shellQuote, type RemoteSshSession } from '../../wrappers/remote-ssh-session'
import { parseOmpJournalHeader } from './journal-header'
import type { RemoteHistoryProbeResult, RemoteHolderState } from './planner'

function parseHolder(value: string): RemoteHolderState {
  if (value === 'gone' || value === 'held' || value === 'unprovable') return value
  throw new Error('Remote history lock probe returned an invalid state.')
}

/**
 * Read-only ownership proof for an RPC-era journal. The command neither kills a process nor
 * creates a lock: an absent lock is gone; an existing lock must be provably acquirable with
 * non-blocking flock. The journal metadata is checked before and after hashing/header capture.
 */
export async function probeRemoteKernelHistory(
  session: Pick<RemoteSshSession, 'execBounded'>,
  reference: RemoteOmpRuntimeRef,
  manifest: PhiSessionManifest,
  signal?: AbortSignal
): Promise<RemoteHistoryProbeResult> {
  if (!session.execBounded) throw new Error('Remote history verification needs bounded SSH exec.')
  const sourcePath = remoteOmpJournalPath(reference)
  const sessionDirectory = posix.dirname(posix.dirname(sourcePath))
  const leaseLock = posix.join(sessionDirectory, 'lease.lock')
  const runLock = posix.join(sessionDirectory, 'run.lock')
  const q = shellQuote
  const command = `set -eu
source_path=${q(sourcePath)}
[ -f "$source_path" ] && [ ! -L "$source_path" ]
[ "$(stat -c %u -- "$source_path")" = "$(id -u)" ]
before=$(stat -c '%s:%Y:%i' -- "$source_path")
size=$(stat -c '%s' -- "$source_path")
if command -v sha256sum >/dev/null 2>&1; then sha=$(sha256sum -- "$source_path" | awk '{print $1}'); else sha=$(shasum -a 256 -- "$source_path" | awk '{print $1}'); fi
head -c 1048576 -- "$source_path" | base64 | tr -d '\r\n'
printf '\n'
probe_lock() {
  if [ ! -e "$1" ]; then printf 'gone'; return; fi
  if [ -L "$1" ] || [ ! -f "$1" ] || ! command -v flock >/dev/null 2>&1; then printf 'unprovable'; return; fi
  if ( exec 9<>"$1"; flock -n 9 ); then printf 'gone'; else printf 'held'; fi
}
printf '%s\n' "$size" "$sha" "$(probe_lock ${q(leaseLock)})" "$(probe_lock ${q(runLock)})"
after=$(stat -c '%s:%Y:%i' -- "$source_path")
[ "$before" = "$after" ]`
  const result = await session.execBounded(command, {
    timeoutMs: 30_000,
    maxOutputBytes: 2 * 1024 * 1024,
    signal
  })
  signal?.throwIfAborted()
  if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated || result.signal) {
    throw new Error('Remote RPC history ownership could not be verified.')
  }
  const lines = result.stdout.trim().split('\n')
  if (lines.length !== 5) throw new Error('Remote history probe returned an invalid response.')
  const header = parseOmpJournalHeader(Buffer.from(lines[0], 'base64'))
  const sourceSize = Number(lines[1])
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 0 || !/^[a-f0-9]{64}$/u.test(lines[2])) {
    throw new Error('Remote history probe returned invalid integrity metadata.')
  }
  return {
    identity: {
      hostProfileId: reference.hostProfileId,
      bindingHash: reference.bindingHash,
      projectId: reference.projectId,
      projectRoot: reference.projectRoot,
      runtimeRoot: reference.runtimeRoot,
      phiSessionId: manifest.sessionId,
      durableSessionKey: reference.durableSessionKey,
      ompSessionId: reference.ompSessionId,
      journalBasename: reference.journalBasename
    },
    sourcePath,
    sourceSize,
    sourceSha256: lines[2],
    sourceOmpSessionId: header.id,
    sourceCwd: header.cwd,
    writer: parseHolder(lines[3]),
    runLock: parseHolder(lines[4]),
    diagnostics: {
      source: 'rpc-era',
      writer: lines[3],
      runLock: lines[4]
    }
  }
}
