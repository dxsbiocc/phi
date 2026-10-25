import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { RemoteSshSession } from '../../src/main/agent/wrappers/remote-ssh-session'
import {
  installRemoteHelper,
  resolveRemoteHelperArtifact,
  type RemoteHelperArtifact
} from '../../src/main/agent/workspace-host/helper-installer'
import type { ProbedHostCapabilityProfile } from '../../src/main/agent/workspace-host/probe-parse'

function explicitHelperArtifact(path: string): RemoteHelperArtifact {
  return {
    version: readFileSync(resolve('helper', 'VERSION'), 'utf8').trim(),
    localPath: path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex')
  }
}

export async function prepareKernelE2eRemoteHelper(options: {
  session: RemoteSshSession
  profile: ProbedHostCapabilityProfile
  hostAlias: string
  runtimeRoot: string
  helperPath?: string
  signal: AbortSignal
}): Promise<void> {
  const artifact = options.helperPath
    ? explicitHelperArtifact(options.helperPath)
    : resolveRemoteHelperArtifact(options.profile)
  if (!artifact) throw new Error('No remote helper artifact matches the SSH host')
  const installed = await installRemoteHelper({
    session: options.session,
    profile: options.profile,
    profileKey: { hostAlias: options.hostAlias, projectRoot: options.runtimeRoot },
    artifact,
    signal: options.signal
  })
  if (!installed.installation) {
    throw new Error(`Remote helper preparation failed: ${installed.reason}`)
  }
}
