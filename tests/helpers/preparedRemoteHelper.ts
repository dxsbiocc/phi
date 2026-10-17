import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  REMOTE_HELPER_READY_MARKER_FILENAME,
  REMOTE_HELPER_READY_MARKER_MODE,
  remoteHelperReadyMarkerIdentity,
  serializeRemoteHelperReadyMarker
} from '../../src/main/agent/remote-helper-marker'
import { saveCapabilityProfile } from '../../src/main/agent/workspace-host/capability-profile-store'
import { resolveRemoteHelperArtifact } from '../../src/main/agent/workspace-host/helper-installer'
import { parseHostCapabilityProbe } from '../../src/main/agent/workspace-host/probe'
import {
  FAST_PROBE_END_SENTINEL,
  FAST_PROBE_START_SENTINEL
} from '../../src/main/agent/workspace-host/probe-script'

const PLATFORM_PROBE = `${FAST_PROBE_START_SENTINEL}\nplatform.os=Linux\nplatform.arch=aarch64\nprobe.fast_complete=1\n${FAST_PROBE_END_SENTINEL}`

/**
 * Leaves the host the way a completed managed-helper install does, so a measured startup
 * is a startup on an already prepared host. The helper binary itself cannot be installed
 * here (the install is Linux-only and the shipped binary is not runnable on this machine),
 * so what is seeded is exactly what the install leaves behind and what startup consumes:
 *   1. `$HOME/.phi/remote/<version>/phi-helper`: a stand-in executable that answers only the
 *      `project-plugin-guard` subcommand the startup transaction runs (mode 0700, owned);
 *   2. the ready marker beside it, byte-identical to what `installRemoteHelper` publishes for
 *      the bundled artifact (version + sha256 from `resources/remote-helper/manifest.json`);
 *   3. the desktop capability profile that records that installation (helperReadyMarker,
 *      helperManagedRoot, helperDirectory), saved under the same profile key production uses.
 * Everything else (probe, runtime root, transaction, markers comparison) is production code.
 */
export async function seedPreparedRemoteHelper(options: {
  runtimeRoot: string
  hostAlias: string
}): Promise<void> {
  const home = await realpath(process.env.HOME!)
  const agentDir = process.env.PI_CODING_AGENT_DIR!
  const probed = parseHostCapabilityProbe(PLATFORM_PROBE)
  const artifact = resolveRemoteHelperArtifact(probed)
  if (!artifact || !artifact.localPath) throw new Error('bundled remote helper artifact is missing')

  const managedRoot = join(home, '.phi', 'remote')
  const directory = join(managedRoot, artifact.version)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const path of [join(home, '.phi'), managedRoot, directory]) await chmod(path, 0o700)
  const helperPath = join(directory, 'phi-helper')
  await writeFile(
    helperPath,
    [
      '#!/bin/sh',
      'case "$1" in',
      `  project-plugin-guard) printf '%s' '{"ok":true}' ;;`,
      `  --selftest) printf '%s' '{"ok":true}' ;;`,
      '  *) exit 64 ;;',
      'esac',
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  await chmod(helperPath, 0o700)
  const identity = remoteHelperReadyMarkerIdentity(artifact)
  const markerPath = join(directory, REMOTE_HELPER_READY_MARKER_FILENAME)
  await writeFile(markerPath, serializeRemoteHelperReadyMarker(identity), {
    mode: REMOTE_HELPER_READY_MARKER_MODE
  })
  await chmod(markerPath, REMOTE_HELPER_READY_MARKER_MODE)

  saveCapabilityProfile(
    { hostAlias: options.hostAlias, projectRoot: await realpath(options.runtimeRoot) },
    {
      ...probed,
      helperVersion: artifact.version,
      helperReadyMarker: identity,
      helperManagedRoot: managedRoot,
      helperDirectory: directory,
      helperStatus: { state: 'available', version: artifact.version, affectedCapabilities: [] }
    },
    agentDir
  )
}
