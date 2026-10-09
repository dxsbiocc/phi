import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  startRemoteWrapperComposition,
  type RemoteJobSnapshot
} from '../src/main/agent/wrappers/composition/remote-job'
import { createLocalShellSession, installSetsidShim } from './helpers/localShellSession'
import { bundledEntry, waitFor, withSandbox } from './helpers/wrapperSandbox'

function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length
}

test('remote Wrapper cancellation releases its poll timer after the SSH session closes', async () => {
  await withSandbox(async (sandbox) => {
    sandbox.useFake()
    process.env.FAKE_NF_MODE = 'hang'

    const remoteRoot = join(sandbox.root, 'remote')
    mkdirSync(remoteRoot, { recursive: true })
    const session = createLocalShellSession(remoteRoot)
    const setsidShim = join(sandbox.root, 'setsid-shim')
    mkdirSync(setsidShim, { recursive: true })
    const restoreSetsid = installSetsidShim(setsidShim)
    const snapshots: RemoteJobSnapshot[] = []
    const baselineTimeouts = activeTimeouts()

    try {
      const wrapperProcess = startRemoteWrapperComposition({
        runId: 'wrun_handle_release',
        entry: bundledEntry(),
        params: { gff: 'tests/data/genome.gff3', outdir: 'results' },
        profile: 'docker',
        target: {
          connection: { host: 'fake-local' },
          workspaceRoot: remoteRoot,
          hpc: { scheduler: 'local', nextflowBin: globalThis.process.env.NEXTFLOW_BIN },
          connectImpl: async () => session,
          skipPreflight: true
        },
        wrappersRoot: sandbox.wrappersRoot,
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        killGraceMs: 500
      })

      await waitFor(() => existsSync(sandbox.pidFile) && snapshots.at(-1)?.pid !== undefined)
      await new Promise<void>((resolve) => setImmediate(resolve))
      wrapperProcess.cancel()

      const result = await wrapperProcess.done
      assert.equal(result.cancelled, true)
      assert.equal(session.closed, true)
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(activeTimeouts(), baselineTimeouts)
    } finally {
      restoreSetsid()
    }
  })
})
