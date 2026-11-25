import { posix } from 'node:path'

import type { ScientificContextSidecar } from '../../../shared/scientificContextTypes'
import { shellQuote, type RemoteSshSession } from '../wrappers/remote-ssh-session'
import {
  buildScientificContextSidecar,
  parseScientificContextSidecarJson,
  scientificContextSidecarPath,
  type CreateScientificContextInput
} from './sidecar'

function withinPosixRoot(candidate: string, root: string): boolean {
  const cleanRoot = posix.resolve(root)
  const cleanCandidate = posix.resolve(candidate)
  return (
    cleanCandidate === cleanRoot ||
    cleanCandidate.startsWith(cleanRoot === '/' ? '/' : `${cleanRoot}/`)
  )
}

/**
 * Computes real SHA-256 of an existing regular file on an SSH remote host.
 * Returns `undefined` when the file is absent/not regular, and throws if the SSH session fails.
 */
export async function computeRemoteArtifactSha256(
  session: RemoteSshSession,
  remotePath: string,
  remoteRootDir?: string
): Promise<string | undefined> {
  if (remoteRootDir && !withinPosixRoot(remotePath, remoteRootDir)) {
    return undefined
  }
  const checkCmd = [
    ...(remoteRootDir
      ? [
          `root_real=$(realpath ${shellQuote(remoteRootDir)} 2>/dev/null) || exit 20`,
          `target_real=$(realpath ${shellQuote(remotePath)} 2>/dev/null) || exit 21`,
          `case "$target_real" in "$root_real"|"$root_real"/*) ;; *) exit 22 ;; esac`
        ]
      : [`target_real=$(realpath ${shellQuote(remotePath)} 2>/dev/null) || exit 21`]),
    `if [ ! -f "$target_real" ]; then exit 23; fi`,
    `if command -v sha256sum >/dev/null 2>&1; then sha256sum "$target_real" | awk '{print $1}'`,
    `elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$target_real" | awk '{print $1}'`,
    `else python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$target_real"`,
    `fi`
  ].join('\n')

  const res = await session.exec(checkCmd)
  if (res.code === 20 || res.code === 21 || res.code === 22 || res.code === 23) {
    return undefined
  }
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `remote sha256 failed with exit code ${String(res.code)}`)
  }
  const digest = res.stdout.trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(digest) ? digest : undefined
}

/**
 * Reads `<remoteArtifactPath>.phi-context.json` from an SSH remote workspace.
 * Throws if the SSH transport fails so callers fail closed instead of silently passing.
 */
export async function readRemoteScientificContextSidecar(
  session: RemoteSshSession,
  remoteArtifactPath: string,
  host: string,
  remoteRootDir?: string
): Promise<{ found: boolean; sidecar: ScientificContextSidecar }> {
  if (remoteRootDir && !withinPosixRoot(remoteArtifactPath, remoteRootDir)) {
    return parseScientificContextSidecarJson(undefined, remoteArtifactPath, 'remote', host)
  }
  const sidecarPath = scientificContextSidecarPath(remoteArtifactPath)
  const exists = await session.exists(sidecarPath)
  if (!exists) {
    return parseScientificContextSidecarJson(undefined, remoteArtifactPath, 'remote', host)
  }
  if (remoteRootDir) {
    const check = await session.exec(
      [
        `root_real=$(realpath ${shellQuote(remoteRootDir)} 2>/dev/null) || exit 20`,
        `target_real=$(realpath ${shellQuote(sidecarPath)} 2>/dev/null) || exit 21`,
        `case "$target_real" in "$root_real"|"$root_real"/*) exit 0 ;; *) exit 22 ;; esac`
      ].join('\n')
    )
    if (check.code !== 0) {
      return parseScientificContextSidecarJson(undefined, remoteArtifactPath, 'remote', host)
    }
  }
  const raw = await session.readTextFile(sidecarPath)
  return parseScientificContextSidecarJson(raw, remoteArtifactPath, 'remote', host)
}

/**
 * Computes real SHA-256 on the remote host (unless already supplied) and writes
 * `<remoteArtifactPath>.phi-context.json` via `session.writeTextFile`.
 */
export async function writeRemoteScientificContextSidecar(
  session: RemoteSshSession,
  remoteArtifactPath: string,
  input: Omit<CreateScientificContextInput, 'location' | 'hashLocalBytes'> & {
    host: string
    hashRemoteBytes?: boolean
    remoteRootDir?: string
  }
): Promise<ScientificContextSidecar> {
  const contentSha256 =
    input.contentSha256 ??
    (input.hashRemoteBytes
      ? await computeRemoteArtifactSha256(session, remoteArtifactPath, input.remoteRootDir)
      : undefined)
  const sidecar = buildScientificContextSidecar({
    ...input,
    location: 'remote',
    path: remoteArtifactPath,
    ...(contentSha256 ? { contentSha256 } : {})
  })
  await session.writeTextFile(
    scientificContextSidecarPath(remoteArtifactPath),
    `${JSON.stringify(sidecar, null, 2)}\n`
  )
  return sidecar
}
