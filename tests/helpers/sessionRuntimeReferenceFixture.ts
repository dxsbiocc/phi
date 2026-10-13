import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPhiSession } from '../../src/main/agent/session/session-store'
import {
  remoteOmpDurableSessionKey,
  type RemoteOmpRuntimeRef
} from '../../src/main/agent/session/runtime-reference'

export const remoteReferenceScope = Object.freeze({
  hostProfileId: 'host-profile-1',
  bindingHash: 'b'.repeat(64),
  projectId: 'project-1',
  projectRoot: '/srv/projects/研究',
  runtimeRoot: '/srv/phi/runtime'
})

export function remoteReference(sessionId: string): RemoteOmpRuntimeRef {
  return {
    ...remoteReferenceScope,
    kind: 'remote-omp',
    version: 1,
    durableSessionKey: remoteOmpDurableSessionKey(remoteReferenceScope, sessionId),
    ompSessionId: 'omp-session-1',
    journalBasename: '2026-10-13_omp-session-1.jsonl',
    ompVersion: '18.10.3',
    checkpoint: { leafId: 'entry-1', verifiedAt: '2026-10-13T08:00:00.000Z' }
  }
}

/** Async fixture keeps every same-text desktop file inside its disposable private data directory. */
export async function withRemoteReferenceSession(
  run: (session: ReturnType<typeof createPhiSession>) => Promise<void>
): Promise<void> {
  const previous = process.env.PI_CODING_AGENT_DIR
  const directory = mkdtempSync(join(tmpdir(), 'phi-runtime-path-fence-'))
  process.env.PI_CODING_AGENT_DIR = directory
  try {
    await run(
      createPhiSession({
        kind: 'project',
        projectId: remoteReferenceScope.projectId,
        projectLocation: {
          kind: 'ssh',
          hostProfileId: remoteReferenceScope.hostProfileId,
          remoteRoot: remoteReferenceScope.projectRoot,
          canonicalRoot: remoteReferenceScope.projectRoot
        },
        cwd: '/desktop/anchor',
        cwdRealPath: '/desktop/anchor',
        permissionMode: 'ask'
      })
    )
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
}
